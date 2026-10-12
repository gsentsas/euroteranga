import { randomBytes } from 'node:crypto';
import type { DatabaseTransaction } from '@euroteranga/database';
import { Secret } from 'otpauth';
import { hashOpaqueToken, type Bytes } from '../crypto/tokens.js';

export const RECOVERY_CODE_COUNT = 10;

/** 80 random bits per code, shown as XXXX-XXXX-XXXX-XXXX (base32). */
function generateRecoveryCode(): string {
  const base32 = new Secret({ buffer: Uint8Array.from(randomBytes(10)).buffer }).base32;
  return base32.match(/.{4}/g)?.join('-') ?? base32;
}

/** Case and separators do not matter when a code is typed back. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

export function hashRecoveryCode(code: string): Bytes {
  return hashOpaqueToken(`recovery:${normalizeRecoveryCode(code)}`);
}

/**
 * Revokes previous codes and stores fresh ones (hashes only). The plain codes
 * are returned once, to be shown to the user, and never persisted or logged.
 */
export async function replaceRecoveryCodes(
  tx: DatabaseTransaction,
  identityId: string,
): Promise<string[]> {
  const now = new Date();
  await tx.mfaRecoveryCode.updateMany({
    where: { identityId, consumedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await tx.mfaRecoveryCode.createMany({
    data: codes.map((code) => ({ identityId, codeHash: hashRecoveryCode(code) })),
  });
  return codes;
}

/** Single use: succeeds for exactly one of any concurrent submissions. */
export async function consumeRecoveryCode(
  tx: DatabaseTransaction,
  identityId: string,
  code: string,
): Promise<boolean> {
  if (normalizeRecoveryCode(code).length !== 16) return false;
  const result = await tx.mfaRecoveryCode.updateMany({
    where: { identityId, codeHash: hashRecoveryCode(code), consumedAt: null, revokedAt: null },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}
