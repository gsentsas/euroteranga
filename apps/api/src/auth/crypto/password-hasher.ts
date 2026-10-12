import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters (encoded in every hash, so they can be raised later
 * without invalidating existing hashes). Benchmarked on the target host class
 * at ~90 ms per hash; well above the OWASP minimum (19 MiB, t=2, p=1).
 * See docs/adr/ADR-014-password-security.md.
 */
export const ARGON2_PARAMETERS = {
  // `Algorithm` is a TypeScript const enum without a runtime value: 2 = Argon2id.
  algorithm: 2,
  memoryCost: 65536, // KiB = 64 MiB
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * Passwords are compared after Unicode NFKC normalisation so that visually
 * identical input typed on different devices produces the same hash.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export function hashPassword(password: string): Promise<string> {
  return hash(normalizePassword(password), ARGON2_PARAMETERS);
}

/** False for a wrong password or an unparseable stored hash (never throws). */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, normalizePassword(password));
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Performs a verification with the same cost as a real one when no account
 * (or no credential) exists, so "unknown email" is not trivially faster than
 * "wrong password". Always resolves to false.
 */
export async function verifyAgainstDummyHash(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  await verifyPassword(await dummyHash, password);
  return false;
}
