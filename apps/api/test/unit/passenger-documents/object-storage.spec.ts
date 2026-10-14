import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalObjectStorageProvider } from '../../../src/passenger-documents/storage/local-object-storage.provider.js';
import {
  ObjectStorageError,
  PASSENGER_DOCUMENT_OBJECT_KEY,
} from '../../../src/passenger-documents/storage/object-storage.provider.js';
import { S3ObjectStorageProvider } from '../../../src/passenger-documents/storage/s3-object-storage.provider.js';

const key = `passenger-documents/ab/${'ab'.repeat(32)}`;

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const part of stream) chunks.push(Buffer.from(part as Uint8Array));
  return Buffer.concat(chunks);
}

describe('private local object storage', () => {
  let roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots = [];
  });

  async function provider() {
    const root = await mkdtemp(join(tmpdir(), 'et-object-storage-'));
    roots.push(root);
    return { root, storage: new LocalObjectStorageProvider(root) };
  }

  it('puts, heads, streams and idempotently deletes exact private bytes', async () => {
    const { root, storage } = await provider();
    const bytes = Buffer.from('%PDF-1.7\nprivate synthetic bytes\n', 'ascii');
    await storage.put({
      key,
      body: Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]),
      sizeBytes: bytes.length,
      mimeType: 'application/pdf',
    });
    expect(await storage.head(key)).toEqual({ sizeBytes: bytes.length });
    expect(await read((await storage.get(key)).body)).toEqual(bytes);
    expect(
      createHash('sha256')
        .update(await readFile(join(root, key)))
        .digest('hex'),
    ).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, 'passenger-documents', 'ab'))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, key))).mode & 0o777).toBe(0o600);
    await storage.delete(key);
    await storage.delete(key);
    await expect(storage.get(key)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects invalid keys, conflicts, short streams and broken streams', async () => {
    const { root, storage } = await provider();
    expect(key).toMatch(PASSENGER_DOCUMENT_OBJECT_KEY);
    await expect(storage.get('../secret')).rejects.toMatchObject({ code: 'INVALID_KEY' });
    await storage.put({
      key,
      body: Readable.from([Buffer.from('abc')]),
      sizeBytes: 3,
      mimeType: 'application/pdf',
    });
    await expect(
      storage.put({ key, body: Readable.from([Buffer.from('abc')]), sizeBytes: 3, mimeType: 'x' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const shortKey = `passenger-documents/cd/${'cd'.repeat(32)}`;
    await expect(
      storage.put({
        key: shortKey,
        body: Readable.from([Buffer.from('abc')]),
        sizeBytes: 4,
        mimeType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(readFile(join(root, shortKey))).rejects.toMatchObject({ code: 'ENOENT' });

    const brokenKey = `passenger-documents/ef/${'ef'.repeat(32)}`;
    const broken = new Readable({
      read() {
        this.destroy(new Error('synthetic source failure'));
      },
    });
    await expect(
      storage.put({ key: brokenKey, body: broken, sizeBytes: 1, mimeType: 'application/pdf' }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('refuses a symbolic-link shard instead of escaping its private root', async () => {
    const { root, storage } = await provider();
    const outside = await mkdtemp(join(tmpdir(), 'et-object-outside-'));
    roots.push(outside);
    await mkdir(join(root, 'passenger-documents'), { recursive: true });
    await symlink(outside, join(root, 'passenger-documents', 'ab'));
    await expect(
      storage.put({ key, body: Readable.from([Buffer.from('x')]), sizeBytes: 1, mimeType: 'x' }),
    ).rejects.toBeInstanceOf(ObjectStorageError);
    await expect(readFile(join(outside, 'ab'.repeat(32)))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a symbolic-link namespace before creating a shard outside its root', async () => {
    const { root, storage } = await provider();
    const outside = await mkdtemp(join(tmpdir(), 'et-object-namespace-outside-'));
    roots.push(outside);
    await symlink(outside, join(root, 'passenger-documents'));
    await expect(
      storage.put({ key, body: Readable.from([Buffer.from('x')]), sizeBytes: 1, mimeType: 'x' }),
    ).rejects.toBeInstanceOf(ObjectStorageError);
    await expect(lstat(join(outside, 'ab'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('private S3-compatible object storage adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  function provider() {
    return new S3ObjectStorageProvider({
      endpoint: 'https://objects.example.test',
      region: 'eu-test-1',
      bucket: 'private-documents',
      accessKeyId: 'ephemeral-access',
      secretAccessKey: 'ephemeral-secret',
      forcePathStyle: true,
    });
  }

  it('puts without any public ACL and forces private no-store caching', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    await provider().put({
      key,
      body: Readable.from([Buffer.from('abc')]),
      sizeBytes: 3,
      mimeType: 'application/pdf',
    });
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: 'private-documents',
      Key: key,
      ContentLength: 3,
      ContentType: 'application/pdf',
      CacheControl: 'private, no-store',
      IfNoneMatch: '*',
    });
    expect((command as PutObjectCommand).input.ACL).toBeUndefined();
  });

  it('streams get/head/delete and normalizes provider errors', async () => {
    const body = Readable.from([Buffer.from('abc')]);
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({ Body: body, ContentLength: 3 } as never)
      .mockResolvedValueOnce({ ContentLength: 3 } as never)
      .mockResolvedValueOnce({} as never);
    const storage = provider();
    expect(await read((await storage.get(key)).body)).toEqual(Buffer.from('abc'));
    expect(await storage.head(key)).toEqual({ sizeBytes: 3 });
    await storage.delete(key);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(DeleteObjectCommand);

    send.mockReset();
    send.mockRejectedValue({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    await expect(storage.get(key)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(storage.head(key)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      storage.put({ key, body: Readable.from([Buffer.from('x')]), sizeBytes: 1, mimeType: 'x' }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });

    send.mockRejectedValue({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
    await expect(
      storage.put({ key, body: Readable.from([Buffer.from('x')]), sizeBytes: 1, mimeType: 'x' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
