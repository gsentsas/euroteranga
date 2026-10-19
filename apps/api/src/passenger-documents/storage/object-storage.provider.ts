import type { Readable } from 'node:stream';

export const OBJECT_STORAGE_PROVIDER = Symbol('OBJECT_STORAGE_PROVIDER');

export const PASSENGER_DOCUMENT_OBJECT_KEY = /^passenger-documents\/[0-9a-f]{2}\/[0-9a-f]{64}$/;
export const INCIDENT_ATTACHMENT_OBJECT_KEY = /^incident-attachments\/[0-9a-f]{2}\/[0-9a-f]{64}$/;
export const FINANCE_RECEIPT_OBJECT_KEY = /^finance-receipts\/[0-9a-f]{2}\/[0-9a-f]{64}$/;
/** MEDIA-1: public website images, in their own store and namespace. */
export const PUBLIC_MEDIA_OBJECT_KEY = /^public-media\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

export type ObjectStorageErrorCode = 'UNAVAILABLE' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID_KEY';

/** Stable infrastructure error; provider responses and endpoints stay private. */
export class ObjectStorageError extends Error {
  constructor(readonly code: ObjectStorageErrorCode) {
    super(`object storage ${code.toLowerCase()}`);
    this.name = 'ObjectStorageError';
  }
}

export interface StoredObject {
  body: Readable;
  sizeBytes: number;
}

/** Provider-neutral private object operations used by the document domain. */
export interface ObjectStorageProvider {
  put(input: { key: string; body: Readable; sizeBytes: number; mimeType: string }): Promise<void>;
  get(key: string): Promise<StoredObject>;
  head(key: string): Promise<{ sizeBytes: number }>;
  /** Idempotent: deleting an already absent object succeeds. */
  delete(key: string): Promise<void>;
}

export function assertPassengerDocumentObjectKey(key: string): void {
  if (!PASSENGER_DOCUMENT_OBJECT_KEY.test(key)) throw new ObjectStorageError('INVALID_KEY');
}

export function assertPrivateObjectKey(key: string): void {
  if (
    !PASSENGER_DOCUMENT_OBJECT_KEY.test(key) &&
    !INCIDENT_ATTACHMENT_OBJECT_KEY.test(key) &&
    !FINANCE_RECEIPT_OBJECT_KEY.test(key)
  ) {
    throw new ObjectStorageError('INVALID_KEY');
  }
}

/** Fail-safe provider used when the document feature is explicitly disabled. */
export class DisabledObjectStorageProvider implements ObjectStorageProvider {
  private unavailable(): never {
    throw new ObjectStorageError('UNAVAILABLE');
  }

  put(): Promise<void> {
    return Promise.reject(this.unavailable());
  }

  get(): Promise<StoredObject> {
    return Promise.reject(this.unavailable());
  }

  head(): Promise<{ sizeBytes: number }> {
    return Promise.reject(this.unavailable());
  }

  delete(): Promise<void> {
    return Promise.reject(this.unavailable());
  }
}

export function assertPublicMediaObjectKey(key: string): void {
  if (!PUBLIC_MEDIA_OBJECT_KEY.test(key)) throw new ObjectStorageError('INVALID_KEY');
}
