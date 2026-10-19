import { PassThrough } from 'node:stream';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { MediaUploadError, parseMediaUpload } from '../../../src/media/media-upload.js';

const BOUNDARY = 'synthetic-media-boundary';

/** A request-like stream: Busboy only needs the headers and the body. */
function fakeRequest(): PassThrough & { headers: Record<string, string> } {
  const stream = new PassThrough() as PassThrough & { headers: Record<string, string> };
  stream.headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
  return stream;
}

function head(): string {
  return (
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="altText"\r\n\r\nAutocar\r\n` +
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\n` +
    'Content-Type: image/jpeg\r\n\r\n'
  );
}

async function outcome(promise: Promise<unknown>, withinMs = 1_000): Promise<string> {
  const timer = new Promise<string>((resolve) => setTimeout(() => resolve('pending'), withinMs));
  return Promise.race([
    promise.then(
      () => 'resolved',
      (error: unknown) => (error instanceof MediaUploadError ? error.code : 'other-error'),
    ),
    timer,
  ]);
}

describe('media multipart parsing (MEDIA-1)', () => {
  it('parses one image and its fields', async () => {
    const request = fakeRequest();
    const parsing = parseMediaUpload(request as unknown as Request, 1_024);
    request.end(`${head()}JPEGDATA\r\n--${BOUNDARY}--\r\n`);
    await expect(parsing).resolves.toMatchObject({ fields: { altText: 'Autocar' } });
  });

  it('settles when the client goes away in the middle of the body', async () => {
    const request = fakeRequest();
    const parsing = parseMediaUpload(request as unknown as Request, 1_024 * 1_024);
    request.write(`${head()}${'x'.repeat(4_096)}`);
    request.destroy();
    expect(await outcome(parsing)).toBe('ABORTED');
  });

  it('settles when the request stream fails', async () => {
    const request = fakeRequest();
    const parsing = parseMediaUpload(request as unknown as Request, 1_024 * 1_024);
    request.write(head());
    request.destroy(new Error('socket reset'));
    expect(await outcome(parsing)).toBe('ABORTED');
  });

  it('settles when the body stalls past the read deadline', async () => {
    const request = fakeRequest();
    const parsing = parseMediaUpload(request as unknown as Request, 1_024 * 1_024, {
      timeoutMs: 50,
    });
    request.write(head());
    expect(await outcome(parsing)).toBe('TIMEOUT');
    expect(request.destroyed).toBe(true);
  });
});
