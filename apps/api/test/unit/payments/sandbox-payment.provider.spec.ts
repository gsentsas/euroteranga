import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  SANDBOX_MAX_PAYLOAD_BYTES,
  SANDBOX_SIGNATURE_TOLERANCE_SECONDS,
  SandboxPaymentProvider,
  signSandboxPayload,
} from '../../../src/payments/providers/sandbox-payment.provider.js';
import { declaredCapability } from '../../../src/payments/payment-capability.registry.js';
import { PAYMENT_METHOD_CODES } from '../../../src/payments/payment-catalog.js';

const timingSafeEqual = vi.hoisted(() => vi.fn());
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual };
});

const key = randomBytes(32);
const provider = new SandboxPaymentProvider(key);
const NOW = 1_900_000_000_000;

const payload = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'evt_0123456789abcdef',
    type: 'payment.succeeded',
    data: {
      providerPaymentId: 'sbx_abcdefghijklmnop',
      amountMinor: 24_690,
      currency: 'EUR',
      ...data,
    },
    ...overrides,
  });

function webhook(
  raw: string,
  options: { timestamp?: number; signature?: string; contentType?: string } = {},
) {
  const timestamp = options.timestamp ?? NOW / 1000;
  const signature = options.signature ?? signSandboxPayload(key, timestamp, raw);
  return {
    rawBody: Buffer.from(raw),
    contentType: options.contentType ?? 'application/json; charset=utf-8',
    header: (name: string) => (name === 'et-sandbox-signature' ? signature : undefined),
  };
}

const codeOf = (fn: () => unknown): [number, string] => {
  try {
    fn();
  } catch (error) {
    const failure = error as { getStatus: () => number; code: string };
    return [failure.getStatus(), failure.code];
  }
  throw new Error('expected a refusal');
};

describe('SANDBOX provider', () => {
  it('declares every method, country and currency of the catalogue, as a test-only adapter', () => {
    expect(provider.capability).toEqual(declaredCapability('SANDBOX'));
    expect(provider.capability).toMatchObject({
      providerCode: 'SANDBOX',
      testMode: true,
      active: true,
      requiresRedirect: false,
      supportedCurrencies: ['EUR', 'XOF', 'MAD', 'MRU'],
      payerCountries: ['FR', 'ES', 'MA', 'MR', 'SN'],
    });
    expect(provider.capability.supportedMethods).toEqual([...PAYMENT_METHOD_CODES]);
    expect(provider.testMode).toBe(true);
  });

  it('keys the attempt on the payment reference alone, whatever the presented amount', async () => {
    const base = {
      paymentReference: 'ETP-000000000002',
      bookingReference: 'ETB-000000000002',
      paymentMethod: 'WAVE_SN',
      payerCountry: 'SN',
      presentmentAmountMinor: 163_333n,
      presentmentCurrencyCode: 'XOF',
      presentmentCurrencyMinorUnit: 0,
    } as const;
    const first = await provider.createPayment(base);
    const again = await provider.createPayment({ ...base, presentmentAmountMinor: 1n });
    expect(again.providerPaymentId).toBe(first.providerPaymentId);
    expect(first.redirectUrl).toBeNull();
  });

  it('creates an idempotent opaque attempt and collects nothing (no redirect, no card data)', async () => {
    const request = {
      paymentReference: 'ETP-000000000000',
      bookingReference: 'ETB-000000000000',
      paymentMethod: 'CARD_CB',
      payerCountry: 'FR',
      presentmentAmountMinor: 24_690n,
      presentmentCurrencyCode: 'EUR',
      presentmentCurrencyMinorUnit: 2,
    } as const;
    const checkout = await provider.createPayment(request);
    const replay = await provider.createPayment(request);
    const other = await provider.createPayment({
      ...request,
      paymentReference: 'ETP-000000000001',
    });
    expect(checkout.providerPaymentId).toMatch(/^sbx_[A-Za-z0-9_-]{24}$/);
    expect(replay.providerPaymentId).toBe(checkout.providerPaymentId);
    expect(other.providerPaymentId).not.toBe(checkout.providerPaymentId);
    expect(checkout.redirectUrl).toBeNull();
    expect(provider.testMode).toBe(true);
  });

  it('verifies the HMAC over "<timestamp>.<raw body>" in constant time', () => {
    const raw = payload();
    timingSafeEqual.mockClear();
    expect(provider.verifyWebhook(webhook(raw), NOW).toString()).toBe(raw);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const [expected, received] = timingSafeEqual.mock.calls[0] as [Buffer, Buffer];
    expect(expected).toHaveLength(32);
    expect(received).toHaveLength(32);
    // A wrong signature of the right length reaches the constant-time compare.
    timingSafeEqual.mockClear();
    const wrong = `t=${NOW / 1000},v1=${'a'.repeat(64)}`;
    expect(codeOf(() => provider.verifyWebhook(webhook(raw, { signature: wrong }), NOW))).toEqual([
      401,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed signatures, stale or future timestamps, other keys and altered bodies', () => {
    const raw = payload();
    const seconds = NOW / 1000;
    for (const signature of [
      '',
      'v1=abc',
      `t=${seconds}`,
      `t=${seconds},v1=${'g'.repeat(64)}`,
      `t=${seconds},v1=${'a'.repeat(63)}`,
    ]) {
      expect(
        codeOf(() => provider.verifyWebhook(webhook(raw, { signature }), NOW)),
        signature,
      ).toEqual([401, 'PAYMENT_WEBHOOK_INVALID']);
    }
    const tolerance = SANDBOX_SIGNATURE_TOLERANCE_SECONDS;
    expect(() =>
      provider.verifyWebhook(webhook(raw, { timestamp: seconds - tolerance }), NOW),
    ).not.toThrow();
    expect(
      codeOf(() =>
        provider.verifyWebhook(webhook(raw, { timestamp: seconds - tolerance - 1 }), NOW),
      )[0],
    ).toBe(401);
    expect(
      codeOf(() =>
        provider.verifyWebhook(webhook(raw, { timestamp: seconds + tolerance + 1 }), NOW),
      )[0],
    ).toBe(401);
    const otherKey = signSandboxPayload(randomBytes(32), seconds, raw);
    expect(
      codeOf(() => provider.verifyWebhook(webhook(raw, { signature: otherKey }), NOW))[0],
    ).toBe(401);
    const altered = { ...webhook(raw), rawBody: Buffer.from(raw.replace('24690', '24691')) };
    expect(codeOf(() => provider.verifyWebhook(altered, NOW))[0]).toBe(401);
  });

  it('refuses other content types, empty and oversized bodies before the signature', () => {
    const raw = payload();
    expect(
      codeOf(() => provider.verifyWebhook(webhook(raw, { contentType: 'text/plain' }), NOW)),
    ).toEqual([415, 'PAYMENT_WEBHOOK_INVALID']);
    expect(
      codeOf(() => provider.verifyWebhook({ ...webhook(raw), contentType: undefined }, NOW))[0],
    ).toBe(415);
    expect(
      codeOf(() => provider.verifyWebhook({ ...webhook(raw), rawBody: undefined }, NOW))[0],
    ).toBe(400);
    const big = 'x'.repeat(SANDBOX_MAX_PAYLOAD_BYTES + 1);
    expect(codeOf(() => provider.verifyWebhook(webhook(big), NOW))).toEqual([
      413,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
  });

  it('parses events into normalized types, codes and a payload hash', () => {
    const raw = payload();
    expect(provider.parseWebhook(Buffer.from(raw))).toEqual({
      providerEventId: 'evt_0123456789abcdef',
      type: 'PAYMENT_SUCCEEDED',
      providerPaymentId: 'sbx_abcdefghijklmnop',
      amountMinor: 24_690n,
      currencyCode: 'EUR',
      failureCode: null,
      payloadHash: createHash('sha256').update(raw).digest('hex'),
    });
    const failure = (reason?: string) =>
      provider.parseWebhook(
        Buffer.from(
          payload(
            { type: 'payment.failed' },
            reason === undefined ? {} : { failureReason: reason },
          ),
        ),
      ).failureCode;
    expect(failure('declined')).toBe('DECLINED');
    expect(failure('insufficient_funds')).toBe('INSUFFICIENT_FUNDS');
    expect(failure('authentication_failed')).toBe('AUTHENTICATION_FAILED');
    expect(failure('checkout_expired')).toBe('CHECKOUT_EXPIRED');
    expect(failure('provider_error')).toBe('PROVIDER_ERROR');
    // Unknown text (including object prototype names) never passes through.
    for (const reason of [
      'Card refused by bank X',
      'constructor',
      '__proto__',
      'toString',
      undefined,
    ]) {
      expect(failure(reason), String(reason)).toBe('UNKNOWN');
    }
  });

  it('refuses payloads outside the strict schema', () => {
    for (const raw of [
      'not json',
      '[]',
      payload({ type: 'payment.refunded' }),
      payload({ id: 'event-1' }),
      payload({ extra: 1 }),
      payload({}, { amountMinor: 1.5 }),
      payload({}, { amountMinor: 0 }),
      payload({}, { amountMinor: Number.MAX_SAFE_INTEGER + 2 }),
      payload({}, { currency: 'euro' }),
      payload({}, { providerPaymentId: 'pi_123456789' }),
      payload({}, { cardNumber: '4111111111111111' }),
      payload({}, { failureReason: 'declined' }),
      payload({ type: 'payment.failed' }, { failureReason: 'x'.repeat(65) }),
    ]) {
      expect(
        codeOf(() => provider.parseWebhook(Buffer.from(raw))),
        raw,
      ).toEqual([400, 'PAYMENT_WEBHOOK_INVALID']);
    }
  });
});
