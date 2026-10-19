import { pipeline } from 'node:stream';
import Busboy from 'busboy';
import type { Request } from 'express';
import { mediaUploadFieldsSchema, type MediaUploadFields } from './media.dto.js';

export type MediaUploadFailure =
  | 'MALFORMED'
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_MEDIA'
  | 'INVALID_FIELDS'
  /** The client went away (or the socket failed) before the end of the body. */
  | 'ABORTED'
  /** The body did not arrive within the read deadline. */
  | 'TIMEOUT';

export class MediaUploadError extends Error {
  constructor(
    readonly code: MediaUploadFailure,
    /** INVALID_FIELDS: names of the refused fields. */
    readonly fields: readonly string[] = [],
  ) {
    super(`media upload ${code.toLowerCase()}`);
    this.name = 'MediaUploadError';
  }
}

export interface ParsedMediaUpload {
  fields: MediaUploadFields;
  data: Buffer;
}

const DECLARED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Longest time to receive a whole upload (10 MiB at about 700 kbit/s). */
export const MEDIA_UPLOAD_READ_TIMEOUT_MS = 120_000;
const FIELD_NAMES = new Set(['altText', 'caption', 'credit', 'focalX', 'focalY', 'replaces']);

/**
 * Parses exactly one bounded multipart image and its describing fields.
 *
 * The image is kept in memory (at most PUBLIC_MEDIA_MAX_BYTES): it is
 * decoded and re-encoded right after, and never written to disk as
 * received. The file name is ignored and never stored. The declared type
 * only has to be an image type: the content itself is checked by magic
 * bytes and by the decoder (media-image.ts).
 *
 * The promise always settles, exactly once: an aborted or failed request
 * (pipeline premature close) and a body that stalls past the read deadline
 * are refused, so the caller's processing slot is always released.
 */
export function parseMediaUpload(
  request: Request,
  maxBytes: number,
  options: { timeoutMs?: number } = {},
): Promise<ParsedMediaUpload> {
  return new Promise<ParsedMediaUpload>((resolveUpload, rejectUpload) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const resolve = (value: ParsedMediaUpload) => settle(() => resolveUpload(value));
    const reject = (error: unknown) => settle(() => rejectUpload(error));
    // Created before anything can settle the promise.
    const timer = setTimeout(() => {
      reject(new MediaUploadError('TIMEOUT'));
      // Stop reading: the response is the refusal, the rest of the body is dropped.
      request.destroy();
    }, options.timeoutMs ?? MEDIA_UPLOAD_READ_TIMEOUT_MS);

    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: request.headers,
        defParamCharset: 'utf8',
        limits: {
          // One sentinel slot beyond the accepted shape: Busboy emits its
          // *Limit event when the count is reached, and the slot is refused.
          files: 2,
          fields: 7,
          parts: 8,
          fieldNameSize: 16,
          // 250 characters of UTF-8 text at most (alternative text).
          fieldSize: 1_024,
          fileSize: maxBytes + 1,
        },
      });
    } catch {
      reject(new MediaUploadError('MALFORMED'));
      return;
    }

    const fields: Record<string, string> = {};
    let unexpected = false;
    let fileSeen = false;
    let declaredType = '';
    let fileDone: Promise<{ data: Buffer; tooLarge: boolean }> | null = null;

    parser.on('field', (name, value, info) => {
      if (
        info.nameTruncated ||
        info.valueTruncated ||
        !FIELD_NAMES.has(name) ||
        Object.hasOwn(fields, name)
      ) {
        unexpected = true;
        return;
      }
      fields[name] = value;
    });

    parser.on('file', (name, file, info) => {
      // A truncated body destroys the stream with an error, possibly before
      // the iterator below is attached; never leave that error uncaught.
      file.on('error', () => undefined);
      if (fileSeen || name !== 'file') {
        unexpected = true;
        file.resume();
        return;
      }
      fileSeen = true;
      declaredType = info.mimeType.toLowerCase();
      fileDone = (async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        for await (const part of file) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
          size += chunk.length;
          // Keep draining after the limit so the parser can finish.
          if (size > maxBytes) {
            tooLarge = true;
            continue;
          }
          chunks.push(chunk);
        }
        return { data: Buffer.concat(chunks), tooLarge: tooLarge || Boolean(file.truncated) };
      })();
      void fileDone.catch(() => undefined);
    });

    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const) {
      parser.on(event, () => {
        unexpected = true;
      });
    }
    // A request destroyed before its end is a client that went away, not a bad form.
    const interrupted = () => request.destroyed && !request.readableEnded;
    parser.on('error', () => reject(new MediaUploadError(interrupted() ? 'ABORTED' : 'MALFORMED')));
    parser.on('finish', () => {
      void (async () => {
        const pending = fileDone as Promise<{ data: Buffer; tooLarge: boolean }> | null;
        if (!fileSeen || !pending || unexpected) throw new MediaUploadError('MALFORMED');
        const file = await pending;
        if (file.tooLarge) throw new MediaUploadError('TOO_LARGE');
        if (file.data.length === 0) throw new MediaUploadError('EMPTY');
        if (!DECLARED_TYPES.has(declaredType)) throw new MediaUploadError('UNSUPPORTED_MEDIA');
        const parsed = mediaUploadFieldsSchema.safeParse(fields);
        if (!parsed.success) {
          const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
          throw new MediaUploadError('INVALID_FIELDS', names);
        }
        resolve({ fields: parsed.data, data: file.data });
      })().catch(reject);
    });

    // Unlike request.pipe(), pipeline() reports a request that closes before
    // its end (client gone, socket reset) and destroys both streams on error.
    pipeline(request, parser, (error) => {
      if (!error) return;
      reject(
        error instanceof MediaUploadError
          ? error
          : new MediaUploadError(
              (error as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE' ||
                interrupted()
                ? 'ABORTED'
                : 'MALFORMED',
            ),
      );
    });
  });
}
