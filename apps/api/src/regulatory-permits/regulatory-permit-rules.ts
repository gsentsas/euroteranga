import { randomInt } from 'node:crypto';
import type { RegulatoryPermitStatus } from '@euroteranga/database';

export const PERMIT_REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PERMIT_REFERENCE_PATTERN = /^ETRP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

export type RegulatoryPermitValidity = 'DRAFT' | 'NOT_YET_VALID' | 'VALID' | 'EXPIRED' | 'REVOKED';

/** ETRP- + 12 Crockford characters, sampled by a CSPRNG (60 bits). */
export function generatePermitReference(
  random: (max: number) => number = (max) => randomInt(max),
): string {
  let body = '';
  for (let index = 0; index < 12; index += 1) {
    body += PERMIT_REFERENCE_ALPHABET[random(PERMIT_REFERENCE_ALPHABET.length)];
  }
  return `ETRP-${body}`;
}

export function normalizePermitReference(value: string): string | null {
  const reference = value.trim().toUpperCase();
  return PERMIT_REFERENCE_PATTERN.test(reference) ? reference : null;
}

export async function withFreshPermitReference<T>(
  attempt: (reference: string) => Promise<T>,
  collision: (error: unknown) => boolean,
  generate: () => string = generatePermitReference,
  maxAttempts = 3,
): Promise<T> {
  for (let number = 1; ; number += 1) {
    try {
      return await attempt(generate());
    } catch (error) {
      if (number >= maxAttempts || !collision(error)) throw error;
    }
  }
}

/** Inclusive calendar-date validity. The caller must supply the evaluation day. */
export function derivePermitValidity(
  permit: { status: RegulatoryPermitStatus; validFrom: string; validUntil: string },
  evaluatedOn: string,
): RegulatoryPermitValidity {
  if (permit.status === 'DRAFT') return 'DRAFT';
  if (permit.status === 'REVOKED') return 'REVOKED';
  if (evaluatedOn < permit.validFrom) return 'NOT_YET_VALID';
  if (evaluatedOn > permit.validUntil) return 'EXPIRED';
  return 'VALID';
}

export function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function dateFromIsoDay(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function isAllowedPermitTransition(
  from: RegulatoryPermitStatus,
  to: RegulatoryPermitStatus,
): boolean {
  return (from === 'DRAFT' && to === 'ACTIVE') || (from === 'ACTIVE' && to === 'REVOKED');
}
