import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  assertPassengerDocumentObjectKey,
  ObjectStorageError,
  type ObjectStorageProvider,
  type StoredObject,
} from './object-storage.provider.js';

export interface S3ObjectStorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/**
 * AWS-SDK adapter for private S3-compatible storage (including MinIO). It
 * never sets a public ACL or emits signed URLs; every read remains behind the
 * authenticated API. Bucket provisioning/policy are intentionally external.
 */
export class S3ObjectStorageProvider implements ObjectStorageProvider {
  private readonly client: S3Client;

  constructor(private readonly options: S3ObjectStorageOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(input: {
    key: string;
    body: Readable;
    sizeBytes: number;
    mimeType: string;
  }): Promise<void> {
    assertPassengerDocumentObjectKey(input.key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: input.key,
          Body: input.body,
          ContentLength: input.sizeBytes,
          ContentType: input.mimeType,
          CacheControl: 'private, no-store',
          // A 256-bit collision is vanishingly unlikely, but it must still
          // fail rather than overwrite an existing private object.
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      if (this.conflict(error)) throw new ObjectStorageError('CONFLICT');
      throw new ObjectStorageError('UNAVAILABLE');
    }
  }

  async get(key: string): Promise<StoredObject> {
    assertPassengerDocumentObjectKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      if (!response.Body || typeof (response.Body as Readable).pipe !== 'function') {
        throw new ObjectStorageError('UNAVAILABLE');
      }
      return {
        body: response.Body as Readable,
        sizeBytes: this.safeSize(response.ContentLength),
      };
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error;
      if (this.notFound(error)) throw new ObjectStorageError('NOT_FOUND');
      throw new ObjectStorageError('UNAVAILABLE');
    }
  }

  async head(key: string): Promise<{ sizeBytes: number }> {
    assertPassengerDocumentObjectKey(key);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return { sizeBytes: this.safeSize(response.ContentLength) };
    } catch (error) {
      if (this.notFound(error)) throw new ObjectStorageError('NOT_FOUND');
      throw new ObjectStorageError('UNAVAILABLE');
    }
  }

  async delete(key: string): Promise<void> {
    assertPassengerDocumentObjectKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
    } catch {
      throw new ObjectStorageError('UNAVAILABLE');
    }
  }

  private safeSize(value: number | undefined): number {
    if (!Number.isSafeInteger(value) || (value ?? 0) < 0) {
      throw new ObjectStorageError('UNAVAILABLE');
    }
    return value!;
  }

  private notFound(error: unknown): boolean {
    const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
    return (
      candidate.name === 'NoSuchKey' ||
      candidate.name === 'NotFound' ||
      candidate.$metadata?.httpStatusCode === 404
    );
  }

  private conflict(error: unknown): boolean {
    const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
    return (
      candidate.name === 'PreconditionFailed' ||
      candidate.name === 'ConditionalRequestConflict' ||
      candidate.$metadata?.httpStatusCode === 412
    );
  }
}
