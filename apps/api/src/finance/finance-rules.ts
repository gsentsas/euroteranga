import { randomBytes, randomInt } from 'node:crypto';
import { BOOKING_REFERENCE_ALPHABET } from '../bookings/booking-rules.js';

const REFERENCE_PATTERNS = {
  revenue: /^ETFR-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/,
  expense: /^ETFE-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/,
  refund: /^ETRF-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/,
  creditNote: /^ETCN-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/,
  payout: /^ETPO-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/,
  receipt: /^ETRC-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/,
} as const;

const PREFIXES = {
  revenue: 'ETFR-',
  expense: 'ETFE-',
  refund: 'ETRF-',
  creditNote: 'ETCN-',
  payout: 'ETPO-',
  receipt: 'ETRC-',
} as const;

export type FinanceReferenceKind = keyof typeof PREFIXES;

export function generateFinanceReference(kind: FinanceReferenceKind): string {
  let body = '';
  for (let index = 0; index < 12; index += 1) {
    body += BOOKING_REFERENCE_ALPHABET[randomInt(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return PREFIXES[kind] + body;
}

export function normalizeFinanceReference(kind: FinanceReferenceKind, raw: string): string | null {
  const value = raw.trim().toUpperCase();
  return REFERENCE_PATTERNS[kind].test(value) ? value : null;
}

export function exactMinorAmount(raw: string): bigint {
  if (!/^[1-9][0-9]{0,17}$/.test(raw)) throw new Error('INVALID_MINOR_AMOUNT');
  return BigInt(raw);
}

export function financeReceiptObjectKey(): string {
  const body = randomBytes(32).toString('hex');
  return 'finance-receipts/' + body.slice(0, 2) + '/' + body;
}

export function currencyKey(code: string, minorUnit: number): string {
  return code + ':' + String(minorUnit);
}
