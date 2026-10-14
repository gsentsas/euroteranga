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

  it.each(['image/png', 'text/html', 'application/octet-stream'])(
    'rejects a real PDF named .pdf when the declared MIME is %s',
    async (mimeType) => {
      // Extension and magic bytes agree: only the declared type disagrees.
      await expectFailure({ filename: 'document.pdf', mimeType, bytes: PDF }, 'UNSUPPORTED_MEDIA');
    },
  );

  it('rejects empty and oversized files without hanging the multipart stream', async () => {
    await expectFailure({ bytes: Buffer.alloc(0) }, 'EMPTY');
    await expectFailure({ bytes: Buffer.concat([PDF, Buffer.alloc(64)]) }, 'TOO_LARGE', 16);
  });

  it.each([
    ['double extension', 'portrait.exe.pdf'],
    ['forward traversal', '../portrait.pdf'],
    ['backslash traversal', '..\\portrait.pdf'],
    ['unicode path control', 'portrait\u202e.pdf'],
    ['nested traversal', '../../passport.pdf'],
    ['nested backslash traversal', '..\\..\\passport.pdf'],
    ['executable behind a document name', 'passport.pdf.exe'],
    ['zero-width joiner', 'pass\u200dport.pdf'],
    ['unicode line separator', 'passport\u2028.pdf'],
    ['unicode paragraph separator', 'passport\u2029.pdf'],
    ['very long', `${'p'.repeat(252)}.pdf`],
    ['leading space', ' passport.pdf'],
  ])('rejects an unsafe %s filename', async (_label, filename) => {
    await expectFailure({ filename }, 'UNSAFE_FILENAME');
  });

  it.each([
    [
      'inside the file part',
      'Content-Disposition: form-data; name="file"; filename="a.pdf"\r\n' +
        'Content-Type: application/pdf\r\n\r\n%PDF-1.7 truncated',
    ],
    ['inside the part headers', 'Content-Disposition: form-data; name="fi'],
    [
      'inside an ignored extra file part',
      'Content-Disposition: form-data; name="file"; filename="a.pdf"\r\n' +
        'Content-Type: application/pdf\r\n\r\n%PDF-1.7 complete\r\n--truncated-boundary\r\n' +
        'Content-Disposition: form-data; name="another"; filename="b.pdf"\r\n' +
        'Content-Type: application/pdf\r\n\r\n%PDF-1.7 truncated',
    ],
  ])('rejects a body truncated %s as MALFORMED, without a stray error', async (_label, parts) => {
    // The whole payload arrives in one chunk, so the request ends while the
    // temporary file is still being opened: the hostile timing for a crash.
    const boundary = 'truncated-boundary';
    const payload = Buffer.from(`--${boundary}\r\n${parts}`, 'utf8');
    const truncated = Object.assign(Readable.from([payload]), {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    }) as unknown as Request;
    await expect(parsePassengerDocumentUpload(truncated, 1024)).rejects.toMatchObject({
      code: 'MALFORMED',
    });
    // Give a late parser/file-stream error a chance to surface as uncaught.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it.each([
    'passport%00.pdf',
    'pass\u2215port.pdf',
    'pass\uff0fport.pdf',
    'passeport d\u2019Awa \u2013 c\u0153ur.pdf',
  ])('parses %s as an untrusted label that never leaves the parser', async (filename) => {
    // Percent-encoding and slash look-alikes are inert text here: nothing in
    // the parsed result (and therefore no key, row, audit or log) keeps it.
    const parsed = await parsePassengerDocumentUpload(multipart({ filename }), 1024);
    try {
      expect(Object.keys(parsed).sort()).toEqual([
        'body',
        'cleanup',
        'fields',
        'mimeType',
        'sha256',
        'sizeBytes',
      ]);
      expect(JSON.stringify(parsed)).not.toContain('port');
    } finally {
      await parsed.cleanup();
    }
  });

  it.each([
    ['status', 'ACCEPTED'],
    ['accepted', 'true'],
    ['mimeType', 'application/pdf'],
    ['objectKey', `passenger-documents/00/${'0'.repeat(64)}`],
    ['scannerStatus', 'CLEAN'],
  ])('refuses a client-supplied %s authority field', async (name, value) => {
    await expectFailure(
      {
        fields: [
          ['type', 'PASSPORT'],
          [name, value],
        ],
      },
      'MALFORMED',
    );
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
