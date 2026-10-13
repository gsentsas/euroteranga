import { describe, expect, it } from 'vitest';
import { bookingStatus } from '../../../src/bookings/booking-rules.js';
import {
  amountToNumber,
  bookingAmountMinor,
  generatePaymentReference,
  normalizePaymentReference,
  parseIdempotencyKey,
  PAYMENT_REFERENCE_PATTERN,
} from '../../../src/payments/payment-rules.js';
import {
  adminPaymentListQuerySchema,
  paymentCreateSchema,
  staffPaymentCancelSchema,
} from '../../../src/payments/payment.dto.js';

/** Largest fare (PostgreSQL INTEGER) and seat limit (BOOKING_MAX_SEATS_PER_HOLD). */
const MAX_FARE = 2_147_483_647;
const MAX_SEATS = 20;

describe('payment references', () => {
  it('are ETP- + 12 CSPRNG Crockford characters, never derived from the booking', () => {
    const references = new Set(Array.from({ length: 200 }, () => generatePaymentReference()));
    expect(references.size).toBe(200);
    for (const reference of references) expect(reference).toMatch(PAYMENT_REFERENCE_PATTERN);
    expect(generatePaymentReference(() => 0)).toBe('ETP-000000000000');
    expect(generatePaymentReference(() => 31)).toBe('ETP-ZZZZZZZZZZZZ');
  });

  it('normalizes customer input and rejects anything else', () => {
    expect(normalizePaymentReference(' etp-abcdefghjkmn ')).toBe('ETP-ABCDEFGHJKMN');
    for (const value of [
      'ETB-ABCDEFGHJKMN',
      'ETP-ABCDEFGHJKM',
      'ETP-ABCDEFGHJKMNP',
      'ETP-ABCDEFGHJKMI',
      '',
    ]) {
      expect(normalizePaymentReference(value), value).toBeNull();
    }
  });
});

describe('idempotency keys', () => {
  it('accepts a bounded token, refuses malformed or repeated headers', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
    expect(parseIdempotencyKey('0f6c2c9e-3b1d-4a77-9b51-2f5d8d5a7c10')).toBe(
      '0f6c2c9e-3b1d-4a77-9b51-2f5d8d5a7c10',
    );
    expect(parseIdempotencyKey('a'.repeat(16))).toBe('a'.repeat(16));
    expect(parseIdempotencyKey('a'.repeat(64))).toBe('a'.repeat(64));
    for (const value of [
      'a'.repeat(15),
      'a'.repeat(65),
      'key with spaces in it',
      'k'.repeat(15) + '/',
      'a, b',
    ]) {
      expect(parseIdempotencyKey(value), value).toBeNull();
    }
    expect(parseIdempotencyKey(['a'.repeat(16), 'b'.repeat(16)])).toBeNull();
  });
});

describe('exact amounts', () => {
  it('derives unit fare x seats with BigInt, beyond 32 bits', () => {
    expect(bookingAmountMinor(12_345, 2)).toBe(24_690n);
    expect(bookingAmountMinor(15_000, 3)).toBe(45_000n);
    expect(bookingAmountMinor(MAX_FARE, MAX_SEATS)).toBe(42_949_672_940n);
    expect(() => bookingAmountMinor(1.5, 2)).toThrow(/safe integers/);
    expect(() => bookingAmountMinor(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(/safe integers/);
  });

  it('returns a JSON number only when exactly representable', () => {
    // EUR (2 decimals) and XOF (0 decimals) amounts within realistic bounds.
    expect(amountToNumber(24_690n)).toBe(24_690);
    expect(amountToNumber(45_000n)).toBe(45_000);
    expect(amountToNumber(42_949_672_940n)).toBe(42_949_672_940);
    expect(Number.isSafeInteger(amountToNumber(42_949_672_940n))).toBe(true);
    expect(amountToNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => amountToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(/safe integer/);
    expect(() => amountToNumber(2n ** 63n - 1n)).toThrow(/safe integer/);
  });
});

describe('booking status with payments (PR-10)', () => {
  it('ranks CANCELLED, then CONFIRMED (whatever the hold expiry), then EXPIRED, then HELD', () => {
    const now = new Date('2030-01-01T10:00:00Z');
    const past = new Date('2030-01-01T09:00:00Z');
    const later = new Date('2030-01-01T11:00:00Z');
    expect(bookingStatus({ cancelledAt: past, confirmedAt: null, holdExpiresAt: later }, now)).toBe(
      'CANCELLED',
    );
    expect(bookingStatus({ cancelledAt: null, confirmedAt: past, holdExpiresAt: past }, now)).toBe(
      'CONFIRMED',
    );
    expect(bookingStatus({ cancelledAt: null, confirmedAt: past, holdExpiresAt: later }, now)).toBe(
      'CONFIRMED',
    );
    expect(bookingStatus({ cancelledAt: null, confirmedAt: null, holdExpiresAt: now }, now)).toBe(
      'EXPIRED',
    );
    expect(bookingStatus({ cancelledAt: null, confirmedAt: null, holdExpiresAt: later }, now)).toBe(
      'HELD',
    );
  });
});

describe('payment request schemas', () => {
  it('accepts no business field from a customer', () => {
    expect(paymentCreateSchema.safeParse({}).success).toBe(true);
    for (const body of [{ amountMinor: 1 }, { currencyCode: 'EUR' }, { provider: 'SANDBOX' }]) {
      expect(paymentCreateSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('bounds STAFF reasons and list filters', () => {
    expect(staffPaymentCancelSchema.safeParse({ reason: '  ok  ' }).success).toBe(false);
    expect(staffPaymentCancelSchema.safeParse({ reason: 'Bloqué' }).success).toBe(true);
    expect(staffPaymentCancelSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
    expect(adminPaymentListQuerySchema.parse({ paymentReference: ' etp-abc ' })).toMatchObject({
      paymentReference: 'ETP-ABC',
      limit: 50,
    });
    expect(adminPaymentListQuerySchema.safeParse({ status: 'PAID' }).success).toBe(false);
    expect(adminPaymentListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});
