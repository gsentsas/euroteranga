import { describe, expect, it } from 'vitest';
import {
  PAYMENT_QUOTE_TTL_SECONDS,
  quoteExpiry,
} from '../../../src/payments/payment-quote.service.js';
import {
  expectedProviderAmount,
  type LockedPayment,
} from '../../../src/payments/payment-webhook.service.js';

const payment = (overrides: Partial<LockedPayment> = {}): LockedPayment => ({
  id: '01900000-0000-7000-8000-000000000001',
  reference: 'ETP-000000000000',
  status: 'PENDING',
  booking_id: '01900000-0000-7000-8000-000000000002',
  amount_minor: 24_900n,
  currency_code: 'EUR',
  currency_minor_unit: 2,
  quote_id: '01900000-0000-7000-8000-000000000003',
  quote_booking_amount_minor: 24_900n,
  quote_booking_currency_code: 'EUR',
  quote_booking_currency_minor_unit: 2,
  presentment_amount_minor: 163_333n,
  presentment_currency_code: 'XOF',
  ...overrides,
});

describe('payment quote rules (PAY-HUB-1)', () => {
  it('expires a quote after its lifetime, never after the booking hold', () => {
    const quotedAt = new Date('2030-03-10T12:00:00.000Z');
    const lifetime = new Date(quotedAt.getTime() + PAYMENT_QUOTE_TTL_SECONDS * 1000);
    expect(quoteExpiry(quotedAt, new Date('2030-03-10T13:00:00.000Z'))).toEqual(lifetime);
    const shortHold = new Date('2030-03-10T12:03:00.000Z');
    expect(quoteExpiry(quotedAt, shortHold)).toEqual(shortHold);
  });

  it('expects the provider to have collected the quote presentment amount and currency', () => {
    expect(expectedProviderAmount(payment())).toEqual({
      amountMinor: 163_333n,
      currencyCode: 'XOF',
    });
  });

  it('expects the payment amount for a PR-10 attempt (no quote)', () => {
    expect(
      expectedProviderAmount(
        payment({
          quote_id: null,
          quote_booking_amount_minor: null,
          quote_booking_currency_code: null,
          quote_booking_currency_minor_unit: null,
          presentment_amount_minor: null,
          presentment_currency_code: null,
        }),
      ),
    ).toEqual({ amountMinor: 24_900n, currencyCode: 'EUR' });
  });

  it('accepts nothing when the quote does not cover exactly the booking amount', () => {
    for (const overrides of [
      { quote_booking_amount_minor: 24_901n },
      { quote_booking_currency_code: 'XOF' },
      { quote_booking_currency_minor_unit: 0 },
      { presentment_amount_minor: null },
    ]) {
      expect(
        expectedProviderAmount(payment(overrides)),
        JSON.stringify(overrides, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ).toBeNull();
    }
  });
});
