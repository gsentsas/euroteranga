import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import {
  parsePassengerDocumentUpload,
  UploadValidationError,
  type UploadFailure,
} from '../../../src/passenger-documents/passenger-document-upload.js';

const PDF = Buffer.from('%PDF-1.7\nsynthetic passenger document\n%%EOF\n', 'ascii');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x45, 0x54, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

interface MultipartOptions {
  filename?: string;
  mimeType?: string;
  bytes?: Buffer;
  fields?: Array<[string, string]>;
  secondFile?: boolean;
}

function multipart(options: MultipartOptions = {}): Request {
  const boundary = '----euroteranga-unit-boundary';
  const chunks: Buffer[] = [];
  const line = (value: string) => chunks.push(Buffer.from(value, 'utf8'));
  for (const [name, value] of options.fields ?? [['type', 'PASSPORT']]) {
    line(`--${boundary}\r\n`);
    line(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  const addFile = (name = 'file') => {
    line(`--${boundary}\r\n`);
    line(
      `Content-Disposition: form-data; name="${name}"; filename="${options.filename ?? 'document.pdf'}"\r\n`,
    );
    line(`Content-Type: ${options.mimeType ?? 'application/pdf'}\r\n\r\n`);
    chunks.push(options.bytes ?? PDF);
    line('\r\n');
  };
  addFile();
  if (options.secondFile) addFile('another');
  line(`--${boundary}--\r\n`);
  const payload = Buffer.concat(chunks);
  return Object.assign(Readable.from([payload]), {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length),
    },
  }) as unknown as Request;
}

async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const part of stream) chunks.push(Buffer.from(part as Uint8Array));
  return Buffer.concat(chunks);
}

async function expectFailure(options: MultipartOptions, code: UploadFailure, maxBytes = 1024) {
  try {
    await parsePassengerDocumentUpload(multipart(options), maxBytes);
    throw new Error('upload unexpectedly accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(UploadValidationError);
    expect((error as UploadValidationError).code).toBe(code);
  }
}

describe('streaming passenger-document upload parser', () => {
  it.each([
    ['PDF', 'document.pdf', 'application/pdf', PDF],
    ['JPEG', 'portrait.jpeg', 'image/jpeg', JPEG],
    ['PNG', 'identity.png', 'image/png', PNG],
  ] as const)(
    'accepts a matching %s extension, MIME and magic signature',
    async (_label, filename, mimeType, bytes) => {
      const parsed = await parsePassengerDocumentUpload(
        multipart({
          filename,
          mimeType,
          bytes,
          fields: [
            ['type', 'NATIONAL_ID'],
            ['expiresAt', '2032-05-09'],
          ],
        }),
        1024,
      );
      try {
        expect(parsed.fields).toEqual({ type: 'NATIONAL_ID', expiresAt: new Date('2032-05-09') });
        expect(parsed.mimeType).toBe(mimeType);
        expect(parsed.sizeBytes).toBe(bytes.length);
        expect(parsed.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(await bytesOf(parsed.body())).toEqual(bytes);
      } finally {
        await parsed.cleanup();
      }
    },
  );

  it('rejects fake, mismatched, executable and unsupported content', async () => {
    await expectFailure(
      { filename: 'fake.pdf', bytes: Buffer.from('not a pdf') },
      'UNSUPPORTED_MEDIA',
    );
    await expectFailure(
      { filename: 'image.jpg', mimeType: 'application/pdf', bytes: PDF },
      'UNSUPPORTED_MEDIA',
    );
    await expectFailure(
      { filename: 'document.pdf', mimeType: 'application/pdf', bytes: PNG },
      'UNSUPPORTED_MEDIA',
    );
    await expectFailure(
      { filename: 'program.pdf', bytes: Buffer.from('MZ synthetic executable', 'ascii') },
      'UNSUPPORTED_MEDIA',
    );
    await expectFailure(
      { filename: 'vector.svg', mimeType: 'image/svg+xml', bytes: Buffer.from('<svg/>') },
      'UNSUPPORTED_MEDIA',
    );
  });

  it('rejects empty and oversized files without hanging the multipart stream', async () => {
    await expectFailure({ bytes: Buffer.alloc(0) }, 'EMPTY');
    await expectFailure({ bytes: Buffer.concat([PDF, Buffer.alloc(64)]) }, 'TOO_LARGE', 16);
  });

  it.each([
    ['double extension', 'portrait.exe.pdf'],
    ['forward traversal', '../portrait.pdf'],
    ['backslash traversal', '..\\portrait.pdf'],
    ['unicode path control', 'portrait\u202e.pdf'],
  ])('rejects an unsafe %s filename', async (_label, filename) => {
    await expectFailure({ filename }, 'UNSAFE_FILENAME');
  });

  it('rejects a control character as a malformed multipart header', async () => {
    await expectFailure({ filename: 'portrait\u0001.pdf' }, 'MALFORMED');
  });

  it('rejects unknown/duplicate fields and more than one file', async () => {
    await expectFailure(
      {
        fields: [
          ['type', 'PASSPORT'],
          ['unexpected', 'value'],
        ],
      },
      'MALFORMED',
    );
    await expectFailure(
      {
        fields: [
          ['type', 'PASSPORT'],
          ['type', 'VISA'],
        ],
      },
      'MALFORMED',
    );
    await expectFailure({ secondFile: true }, 'MALFORMED');
  });
});
