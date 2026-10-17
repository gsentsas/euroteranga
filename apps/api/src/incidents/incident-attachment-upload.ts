'use strict';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import Busboy from 'busboy';
import type { Request } from 'express';
import { UploadValidationError } from '../passenger-documents/passenger-document-upload.js';

export interface ParsedIncidentAttachmentUpload {
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
  sha256: string;
  body(): Readable;
  cleanup(): Promise<void>;
}

const ALLOWED = {
  '.pdf': { mimeType: 'application/pdf', magic: Buffer.from('%PDF-', 'ascii') },
  '.jpg': { mimeType: 'image/jpeg', magic: Buffer.from([0xff, 0xd8, 0xff]) },
  '.jpeg': { mimeType: 'image/jpeg', magic: Buffer.from([0xff, 0xd8, 0xff]) },
  '.png': {
    mimeType: 'image/png',
    magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
} as const;

type AllowedExtension = keyof typeof ALLOWED;

function expectedFile(filename: string): (typeof ALLOWED)[AllowedExtension] {
  const normalized = filename.normalize('NFC');
  if (
    normalized.length < 3 ||
    normalized.length > 255 ||
    normalized !== normalized.trim() ||
    /[/\\\0\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized)
  ) {
    throw new UploadValidationError('UNSAFE_FILENAME');
  }
  const dot = normalized.lastIndexOf('.');
  if (dot <= 0 || normalized.slice(0, dot).includes('.')) {
    throw new UploadValidationError('UNSAFE_FILENAME');
  }
  const extension = normalized.slice(dot).toLowerCase() as AllowedExtension;
  const expected = ALLOWED[extension];
  if (!expected) throw new UploadValidationError('UNSUPPORTED_MEDIA');
  return expected;
}

function hasMagic(prefix: Buffer, expected: Buffer): boolean {
  return prefix.length >= expected.length && prefix.subarray(0, expected.length).equals(expected);
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    if (bytesWritten <= 0) throw new Error('temporary upload write made no progress');
    offset += bytesWritten;
  }
}

/**
 * Strict one-file multipart parser for private incident evidence.
 * No multipart text field is accepted: only a single part named "file".
 */
export async function parseIncidentAttachmentUpload(
  request: Request,
  maxBytes: number,
): Promise<ParsedIncidentAttachmentUpload> {
  const directory = await mkdtemp(join(tmpdir(), 'euroteranga-incident-attachment-'));
  await chmod(directory, 0o700);
  const path = join(directory, 'body');
  const cleanup = () => rm(directory, { recursive: true, force: true });

  try {
    const parsed = await new Promise<{
      filename: string;
      declaredMime: string;
      sizeBytes: number;
      sha256: string;
      prefix: Buffer;
    }>((resolve, reject) => {
      let parser: ReturnType<typeof Busboy>;
      try {
        parser = Busboy({
          headers: request.headers,
          preservePath: true,
          defParamCharset: 'utf8',
          limits: {
            files: 2,
            fields: 1,
            parts: 2,
            fieldNameSize: 32,
            fieldSize: 32,
            fileSize: maxBytes + 1,
          },
        });
      } catch {
        reject(new UploadValidationError('MALFORMED'));
        return;
      }

      let fileSeen = false;
      let duplicateOrUnexpected = false;
      let fileResult: Promise<{
        filename: string;
        declaredMime: string;
        sizeBytes: number;
        sha256: string;
        prefix: Buffer;
      }> | null = null;

      parser.on('field', () => {
        duplicateOrUnexpected = true;
      });

      parser.on('file', (name, file, info) => {
        file.on('error', () => undefined);
        if (fileSeen || name !== 'file') {
          duplicateOrUnexpected = true;
          file.resume();
          return;
        }
        fileSeen = true;
        fileResult = (async () => {
          const handle = await open(path, 'wx', 0o600);
          const hash = createHash('sha256');
          let sizeBytes = 0;
          let prefix = Buffer.alloc(0);
          let tooLarge = false;
          try {
            for await (const part of file) {
              const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
              sizeBytes += chunk.length;
              if (sizeBytes > maxBytes) {
                tooLarge = true;
                continue;
              }
              hash.update(chunk);
              if (prefix.length < 8) {
                prefix = Buffer.concat([prefix, chunk]).subarray(0, 8);
              }
              await writeAll(handle, chunk);
            }
            if (file.truncated || tooLarge || sizeBytes > maxBytes) {
              throw new UploadValidationError('TOO_LARGE');
            }
            await handle.close();
            await chmod(path, 0o600);
            return {
              filename: info.filename ?? '',
              declaredMime: info.mimeType.toLowerCase(),
              sizeBytes,
              sha256: hash.digest('hex'),
              prefix,
            };
          } catch (error) {
            await handle.close().catch(() => undefined);
            throw error;
          }
        })();
        void fileResult.catch(() => undefined);
      });

      parser.on('filesLimit', () => {
        duplicateOrUnexpected = true;
      });
      parser.on('fieldsLimit', () => {
        duplicateOrUnexpected = true;
      });
      parser.on('partsLimit', () => {
        duplicateOrUnexpected = true;
      });
      parser.on('error', () => reject(new UploadValidationError('MALFORMED')));
      parser.on('finish', () => {
        void (async () => {
          if (!fileSeen || !fileResult || duplicateOrUnexpected) {
            throw new UploadValidationError('MALFORMED');
          }
          resolve(await fileResult);
        })().catch(reject);
      });

      request.pipe(parser);
    });

    if (parsed.sizeBytes === 0) throw new UploadValidationError('EMPTY');
    const expected = expectedFile(parsed.filename);
    if (parsed.declaredMime !== expected.mimeType || !hasMagic(parsed.prefix, expected.magic)) {
      throw new UploadValidationError('UNSUPPORTED_MEDIA');
    }

    return {
      mimeType: expected.mimeType,
      sizeBytes: parsed.sizeBytes,
      sha256: parsed.sha256,
      body: () => createReadStream(path),
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
