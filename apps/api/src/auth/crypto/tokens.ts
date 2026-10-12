import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque tokens (sessions, challenges, email links) carry 256 bits of entropy. */
export const OPAQUE_TOKEN_BYTES = 32;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** CSPRNG token, base64url encoded (43 characters for 32 bytes). */
export function secureRandomToken(): string {
  return randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
}

/** Cheap syntactic check so malformed input never reaches the database. */
export function isWellFormedOpaqueToken(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_TOKEN_PATTERN.test(value);
}

/** Database byte columns are typed as ArrayBuffer-backed Uint8Array. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Copies a Node.js Buffer into a standalone byte array for database writes. */
export function toBytes(buffer: Uint8Array): Bytes {
  return new Uint8Array(buffer);
}

/**
 * Digest stored instead of an opaque token. A plain SHA-256 is sufficient:
 * the tokens are 256-bit random values, so they cannot be guessed or
 * brute-forced from the digest (unlike passwords).
 */
export function hashOpaqueToken(token: string): Bytes {
  return toBytes(createHash('sha256').update(token, 'utf8').digest());
}

/** Keyed digest (HMAC-SHA256) of several parts, unambiguously separated. */
export function keyedDigest(key: Buffer, parts: readonly string[]): Buffer {
  const hmac = createHmac('sha256', key);
  for (const part of parts) {
    hmac
      .update(String(Buffer.byteLength(part, 'utf8')))
      .update(':')
      .update(part, 'utf8');
  }
  return hmac.digest();
}

/** Constant-time comparison of two secrets; different lengths never match. */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
