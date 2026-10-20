import { randomInt } from 'node:crypto';
import { BOOKING_REFERENCE_ALPHABET } from '../bookings/booking-rules.js';

/** Same format as the payment_reference_format CHECK. */
export const PAYMENT_REFERENCE_PATTERN = /^ETP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
const REFERENCE_LENGTH = 12;

/**
 * Public payment reference: ETP- followed by 12 characters drawn with a
 * CSPRNG (60 bits). Never derived from the booking reference, the customer
 * or the time.
 */
export function generatePaymentReference(
  random: (max: number) => number = (max) => randomInt(max),
): string {
  let body = '';
  for (let index = 0; index < REFERENCE_LENGTH; index += 1) {
    body += BOOKING_REFERENCE_ALPHABET[random(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return `ETP-${body}`;
}

/** Customer input: trimmed, uppercase; anything else is simply not found. */
export function normalizePaymentReference(value: string): string | null {
  const reference = value.trim().toUpperCase();
  return PAYMENT_REFERENCE_PATTERN.test(reference) ? reference : null;
}

/**
 * Provider-side idempotency key of the capture of an attempt (PAY-PAYPAL-1):
 * derived from its reference, never random, so every redelivered approval
 * asks for the very same capture. Distinct from the creation key (the
 * reference itself), as PayPal requires one key per call type; 24 characters,
 * within PayPal-Request-Id's 38.
 */
export function captureIdempotencyKey(paymentReference: string): string {
  return `${paymentReference}-CAPTURE`;
}

/** Same format as the payment_idempotency_key_format CHECK (e.g. a UUID). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The optional Idempotency-Key header: absent is fine, present must be one
 * bounded token. Returns undefined when absent, null when malformed.
 */
export function parseIdempotencyKey(
  value: string | string[] | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return null;
  return IDEMPOTENCY_KEY_PATTERN.test(value) ? value : null;
}

/**
 * Normalized failure codes (payment_failure_code_known CHECK). Provider
 * vocabularies are mapped onto them; raw provider text is never stored or
 * returned.
 */
export const PROVIDER_FAILURE_CODES = [
  'DECLINED',
  'INSUFFICIENT_FUNDS',
  'AUTHENTICATION_FAILED',
  'CHECKOUT_EXPIRED',
  'PROVIDER_ERROR',
  'UNKNOWN',
] as const;
/** Failures decided by EURO TERANGA when a success can no longer apply. */
export const BOOKING_FAILURE_CODES = ['BOOKING_EXPIRED', 'BOOKING_NOT_PAYABLE'] as const;
export type PaymentFailureCode =
  (typeof PROVIDER_FAILURE_CODES)[number] | (typeof BOOKING_FAILURE_CODES)[number];

/** Why a recorded provider event changed nothing (payment_event_outcome_consistent CHECK). */
export type PaymentEventRejection =
  'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'PAYMENT_NOT_PENDING' | 'PAYMENT_ALREADY_SUCCEEDED';

export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/**
 * Exact amount of a booking: unit fare x seats, in integer (BigInt)
 * arithmetic. The client never sends an amount.
 */
export function bookingAmountMinor(unitAmountMinor: number, seatCount: number): bigint {
  if (!Number.isSafeInteger(unitAmountMinor) || !Number.isSafeInteger(seatCount)) {
    throw new Error('amount and seat count must be safe integers');
  }
  return BigInt(unitAmountMinor) * BigInt(seatCount);
}

/** Whole seconds of hold left at `now` (negative once expired). */
export function holdRemaining(holdExpiresAt: Date, now: Date): number {
  return Math.floor((holdExpiresAt.getTime() - now.getTime()) / 1000);
}

/** A BIGINT amount as a JSON number, only when it is exactly representable. */
export function amountToNumber(amountMinor: bigint): number {
  const value = Number(amountMinor);
  if (!Number.isSafeInteger(value) || BigInt(value) !== amountMinor) {
    throw new Error('payment amount exceeds the safe integer range');
  }
  return value;
}
