import { randomInt } from 'node:crypto';
import { BOOKING_REFERENCE_ALPHABET } from '../bookings/booking-rules.js';

export const CARGO_QUOTE_REFERENCE_PATTERN = /^ETCQ-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

export type CargoQuoteLineKind = 'CHARGE' | 'DISCOUNT';

export interface CargoQuoteMoneyLine {
  kind: CargoQuoteLineKind;
  amountMinor: string;
}

/** Opaque 60-bit commercial quote reference; no customer or routing data. */
export function generateCargoQuoteReference(
  random: (max: number) => number = (max) => randomInt(max),
): string {
  let body = '';
  for (let index = 0; index < 12; index += 1) {
    body += BOOKING_REFERENCE_ALPHABET[random(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return `ETCQ-${body}`;
}

export function normalizeCargoQuoteReference(value: string): string | null {
  const reference = value.trim().toUpperCase();
  return CARGO_QUOTE_REFERENCE_PATTERN.test(reference) ? reference : null;
}

export function exactCargoQuoteAmount(raw: string): bigint {
  if (!/^[1-9][0-9]{0,17}$/.test(raw)) throw new Error('INVALID_CARGO_QUOTE_AMOUNT');
  return BigInt(raw);
}

export function cargoQuoteTotal(lines: readonly CargoQuoteMoneyLine[]): bigint {
  let charges = 0n;
  let discounts = 0n;
  for (const line of lines) {
    const amount = exactCargoQuoteAmount(line.amountMinor);
    if (line.kind === 'CHARGE') charges += amount;
    else discounts += amount;
  }
  if (discounts > charges) throw new Error('NEGATIVE_CARGO_QUOTE_TOTAL');
  return charges - discounts;
}

export async function withFreshCargoQuoteReference<T>(
  attempt: (reference: string) => Promise<T>,
  collision: (error: unknown) => boolean,
  generate: () => string = generateCargoQuoteReference,
): Promise<T> {
  for (let index = 0; index < 3; index += 1) {
    try {
      return await attempt(generate());
    } catch (error) {
      if (index === 2 || !collision(error)) throw error;
    }
  }
  throw new Error('unreachable');
}
