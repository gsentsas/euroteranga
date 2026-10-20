import { createLogger } from '@euroteranga/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PaymentCapabilityRegistry,
  PROVIDER_CAPABILITY_DECLARATIONS,
  WAVE_COLLECTION_WINDOW_SECONDS,
  WAVE_HOLD_MARGIN_SECONDS,
} from '../../../src/payments/payment-capability.registry.js';
import type { ProviderPaymentRequest } from '../../../src/payments/providers/payment-provider.js';
import {
  WAVE_FUTURE_TOLERANCE_SECONDS,
  WAVE_MAX_PAYLOAD_BYTES,
  WAVE_SIGNATURE_TOLERANCE_SECONDS,
  WaveHttpGateway,
  WavePaymentProvider,
  waveSignature,
  xofMinorToWaveAmount,
} from '../../../src/payments/providers/wave-payment.provider.js';
import {
  FakeWaveGateway,
  syntheticWaveWebhookSecret,
  waveCheckoutEvent,
  waveWebhookSignature,
} from '../../support/wave-helpers.js';

const NOW = 1_792_496_000_000;
const RETURN_URL = 'https://client.example.test/compte';

afterEach(() => vi.unstubAllGlobals());

function setup(gateway = new FakeWaveGateway()) {
  const lines: string[] = [];
  const webhookSecret = syntheticWaveWebhookSecret();
  const logger = createLogger({
    service: 'test',
    level: 'debug',
    write: (line) => lines.push(line),
  });
  const provider = new WavePaymentProvider({
    gateway,
    webhookSecret,
    returnUrl: RETURN_URL,
    logger,
  });
  return { provider, gateway, webhookSecret, lines };
}

const payment = (overrides: Partial<ProviderPaymentRequest> = {}): ProviderPaymentRequest => ({
  paymentReference: 'ETP-ABCDEFGHJK23',
  bookingReference: 'ETB-ABCDEFGHJK23',
  paymentMethod: 'WAVE_SN',
  payerCountry: 'SN',
  presentmentAmountMinor: 24_900n,
  presentmentCurrencyCode: 'XOF',
  presentmentCurrencyMinorUnit: 0,
  expiresAt: new Date(Date.now() + WAVE_COLLECTION_WINDOW_SECONDS * 1000),
  ...overrides,
});

async function codeOf(run: () => unknown) {
  try {
    await run();
  } catch (error) {
    const typed = error as { getStatus?: () => number; code?: string };
    return [typed.getStatus?.(), typed.code];
  }
  return null;
}

function webhook(raw: string | Buffer | undefined, signature = '') {
  return {
    rawBody: raw === undefined ? undefined : Buffer.isBuffer(raw) ? raw : Buffer.from(raw),
    contentType: 'application/json; charset=utf-8',
    header: (name: string) => (name.toLowerCase() === 'wave-signature' ? signature : undefined),
  };
}

describe('Wave direct capability and routing (PAY-SN-1A)', () => {
  it('routes only WAVE_SN / SN / XOF after 35 minutes of hold', () => {
    const { provider } = setup();
    const registry = new PaymentCapabilityRegistry([provider]);
    const route = (overrides: Record<string, unknown> = {}) =>
      registry.route({
        method: 'WAVE_SN',
        payerCountry: 'SN',
        currencyCode: 'XOF',
        presentmentAmountMinor: 24_900n,
        holdRemainingSeconds: WAVE_COLLECTION_WINDOW_SECONDS + WAVE_HOLD_MARGIN_SECONDS,
        ...overrides,
      })?.provider.name ?? null;

    expect(provider.capability).toMatchObject({
      supportedMethods: ['WAVE_SN'],
      payerCountries: ['SN'],
      supportedCurrencies: ['XOF'],
      requiresRedirect: true,
      requiresPhone: false,
      collectionWindowSeconds: 1800,
      minimumHoldRemainingSeconds: 2100,
    });
    expect(route()).toBe('WAVE');
    expect(route({ method: 'ORANGE_MONEY_SN' })).toBeNull();
    expect(route({ method: 'CARD' })).toBeNull();
    expect(route({ payerCountry: 'FR' })).toBeNull();
    expect(route({ currencyCode: 'EUR' })).toBeNull();
    expect(route({ holdRemainingSeconds: 2099 })).toBeNull();
  });

  it('keeps aggregators non-routable and Orange blocked', () => {
    const declarations = Object.fromEntries(
      PROVIDER_CAPABILITY_DECLARATIONS.map((item) => [item.providerCode, item]),
    );
    expect(declarations.WAVE).toMatchObject({ implemented: true, supportedMethods: ['WAVE_SN'] });
    expect(declarations.ORANGE_MONEY).toMatchObject({
      implemented: false,
      supportedMethods: ['ORANGE_MONEY_SN'],
    });
    for (const name of ['PAYDUNYA', 'PAYTECH'] as const) {
      expect(declarations[name]).toMatchObject({
        implemented: false,
        supportedMethods: [],
        payerCountries: [],
        supportedCurrencies: [],
      });
    }
  });
});

describe('Wave Checkout creation and recovery', () => {
  it('requires a server-configured HTTPS return URL', () => {
    const gateway = new FakeWaveGateway();
    const logger = createLogger({ service: 'test', level: 'error', write: () => {} });
    expect(
      () =>
        new WavePaymentProvider({
          gateway,
          webhookSecret: syntheticWaveWebhookSecret(),
          returnUrl: 'http://client.example.test/compte',
          logger,
        }),
    ).toThrow('HTTPS server configuration URL');
  });

  it('signs exact POST bodies and bodyless GETs against the fixed Wave API origin', async () => {
    const input = {
      amount: '24900',
      currency: 'XOF' as const,
      client_reference: 'ETP-ABCDEFGHJK23',
      success_url: 'https://client.example.test/compte?paiement=retour-wave',
      error_url: 'https://client.example.test/compte?paiement=abandon-wave',
    };
    const sessionId = FakeWaveGateway.sessionIdFor(input.client_reference);
    const session = {
      id: sessionId,
      amount: input.amount,
      checkout_status: 'open',
      client_reference: input.client_reference,
      currency: 'XOF',
      error_url: input.error_url,
      payment_status: 'processing',
      success_url: input.success_url,
      wave_launch_url: `https://pay.wave.com/c/${sessionId}`,
      when_created: '2026-10-20T12:00:00Z',
      when_expires: '2026-10-20T12:30:00Z',
    };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = String(url).includes('/search') ? { result: [session] } : session;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const signingSecret = `wave_sn_AKS_${'a'.repeat(48)}`;
    const apiKey = `wave_sn_prod_${'b'.repeat(48)}`;
    const timestamp = Math.floor(NOW / 1000);
    const gateway = new WaveHttpGateway(apiKey, signingSecret, () => NOW);

    await gateway.createCheckout(input);
    await gateway.findCheckoutsByClientReference(input.client_reference);
    expect(calls[0]!.url).toBe('https://api.wave.com/v1/checkout/sessions');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: JSON.stringify(input) });
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(new Headers(calls[0]!.init.headers).get('wave-signature')).toBe(
      waveSignature(signingSecret, timestamp, JSON.stringify(input)),
    );
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]!.url).toBe(
      'https://api.wave.com/v1/checkout/sessions/search?client_reference=ETP-ABCDEFGHJK23',
    );
    expect(calls[1]!.init.body).toBeUndefined();
    expect(new Headers(calls[1]!.init.headers).get('wave-signature')).toBe(
      waveSignature(signingSecret, timestamp, ''),
    );
  });

  it('fails closed when the Wave search response is malformed', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const gateway = new WaveHttpGateway(
      `wave_sn_prod_${'b'.repeat(48)}`,
      `wave_sn_AKS_${'a'.repeat(48)}`,
      () => NOW,
    );

    await expect(gateway.findCheckoutsByClientReference('ETP-ABCDEFGHJK23')).rejects.toThrow(
      'Wave request failed',
    );
  });

  it('sends the exact integer XOF quote, reference and server-controlled URLs', async () => {
    const { provider, gateway } = setup();
    const result = await provider.createPayment(payment());
    expect(gateway.searchCalls).toEqual(['ETP-ABCDEFGHJK23']);
    expect(gateway.createCalls).toEqual([
      {
        input: {
          amount: '24900',
          currency: 'XOF',
          client_reference: 'ETP-ABCDEFGHJK23',
          success_url: 'https://client.example.test/compte?paiement=retour-wave',
          error_url: 'https://client.example.test/compte?paiement=abandon-wave',
        },
      },
    ]);
    expect(result).toEqual({
      providerPaymentId: FakeWaveGateway.sessionIdFor('ETP-ABCDEFGHJK23'),
      redirectUrl: `https://pay.wave.com/c/${FakeWaveGateway.sessionIdFor('ETP-ABCDEFGHJK23')}`,
    });
  });

  it('formats XOF without a float and rejects zero, negative or oversized amounts', () => {
    expect(xofMinorToWaveAmount(1n)).toBe('1');
    expect(xofMinorToWaveAmount(99_999_999n)).toBe('99999999');
    expect(() => xofMinorToWaveAmount(0n)).toThrow();
    expect(() => xofMinorToWaveAmount(-1n)).toThrow();
    expect(() => xofMinorToWaveAmount(10n ** 15n)).toThrow();
  });

  it.each([
    [{ paymentMethod: 'ORANGE_MONEY_SN' }, 'PAYMENT_METHOD_UNAVAILABLE'],
    [{ payerCountry: 'FR' }, 'PAYMENT_COUNTRY_UNSUPPORTED'],
    [{ presentmentCurrencyCode: 'EUR' }, 'PAYMENT_CURRENCY_UNSUPPORTED'],
    [{ presentmentCurrencyMinorUnit: 2 }, 'PAYMENT_CURRENCY_UNSUPPORTED'],
  ] as const)('rejects an out-of-contract request', async (overrides, code) => {
    const { provider, gateway } = setup();
    expect(await codeOf(() => provider.createPayment(payment(overrides)))).toEqual([
      expect.any(Number),
      code,
    ]);
    expect(gateway.createCalls).toHaveLength(0);
  });

  it('reuses the single exact checkout found by client_reference', async () => {
    const { provider, gateway } = setup();
    const first = await provider.createPayment(payment());
    const replay = await provider.createPayment(payment());
    expect(replay).toEqual(first);
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.searchCalls).toHaveLength(2);
  });

  it(
    'recovers an existing checkout but refuses a fresh one after the original hold margin is spent',
    async () => {
      const lateExpiresAt = () =>
        new Date(
          Date.now() +
            (WAVE_COLLECTION_WINDOW_SECONDS - WAVE_HOLD_MARGIN_SECONDS) * 1000 -
            1,
        );

      const existing = setup();
      const first = await existing.provider.createPayment(payment());
      expect(
        await existing.provider.createPayment(payment({ expiresAt: lateExpiresAt() })),
      ).toEqual(first);
      expect(existing.gateway.createCalls).toHaveLength(1);

      const fresh = setup();
      expect(
        await codeOf(() => fresh.provider.createPayment(payment({ expiresAt: lateExpiresAt() }))),
      ).toEqual([409, 'PAYMENT_BOOKING_EXPIRED']);
      expect(fresh.gateway.searchCalls).toEqual(['ETP-ABCDEFGHJK23']);
      expect(fresh.gateway.createCalls).toHaveLength(0);
    },
  );

  it('recovers an unknown create result by reference without creating twice', async () => {
    const { provider, gateway } = setup();
    gateway.failAfterCreate = new Error('synthetic timeout after remote commit');
    const result = await provider.createPayment(payment());
    expect(result.providerPaymentId).toBe(FakeWaveGateway.sessionIdFor('ETP-ABCDEFGHJK23'));
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.searchCalls).toHaveLength(2);
  });

  it('leaves an unknown create PENDING/recoverable when no checkout can be found', async () => {
    const { provider, gateway } = setup();
    gateway.onCreate = async () => {
      gateway.failNext = new Error('synthetic timeout before remote commit');
    };
    expect(await codeOf(() => provider.createPayment(payment()))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
    expect(gateway.createCalls).toHaveLength(1);
  });

  it('fails closed when search is unavailable or ambiguous', async () => {
    const first = setup();
    first.gateway.failNext = new Error('search unavailable');
    expect(await codeOf(() => first.provider.createPayment(payment()))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
    expect(first.gateway.createCalls).toHaveLength(0);

    const second = setup();
    await second.provider.createPayment(payment());
    const existing = second.gateway.sessions.get(payment().paymentReference)!;
    second.gateway.sessions.set(payment().paymentReference, [existing[0]!, { ...existing[0]! }]);
    expect(await codeOf(() => second.provider.createPayment(payment()))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
    expect(second.gateway.createCalls).toHaveLength(1);
  });

  it.each([
    ['id', 'cos-UPPERCASE'],
    ['wave_launch_url', 'https://evil.example.test/c/cos-1234567890abcdef'],
    ['wave_launch_url', 'https://pay.wave.com.evil.test/c/cos-1234567890abcdef'],
    ['wave_launch_url', 'https://user:pass@pay.wave.com/c/cos-1234567890abcdef'],
    ['wave_launch_url', 'https://pay.wave.com/c/cos-1234567890abcdef#fake'],
    ['amount', '24901'],
    ['currency', 'EUR'],
    ['client_reference', 'ETP-OTHERREF1234'],
    ['success_url', 'https://evil.example.test/return'],
    ['error_url', 'https://evil.example.test/error'],
    ['when_expires', '2026-10-20T12:35:01Z'],
    ['payment_status', 'cancelled'],
  ])('rejects a provider response with malicious/mismatched %s', async (field, value) => {
    const { provider, gateway } = setup();
    gateway.override = { [field]: value };
    expect(await codeOf(() => provider.createPayment(payment()))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
  });
});

describe('Wave expiry/cancellation', () => {
  it('expires an open checkout before allowing local cancellation', async () => {
    const { provider, gateway } = setup();
    const checkout = await provider.createPayment(payment());
    expect(await provider.cancelPayment(checkout.providerPaymentId)).toBe('CLOSED');
    expect(gateway.expireCalls).toEqual([checkout.providerPaymentId]);
  });

  it('distinguishes already expired from already completed after a 409', async () => {
    const expired = setup();
    const checkout = await expired.provider.createPayment(payment());
    expired.gateway.expireResult = 'CONFLICT';
    expect(await expired.provider.cancelPayment(checkout.providerPaymentId)).toBe('CLOSED');

    expired.gateway.statusAfterConflict = {
      checkout_status: 'complete',
      payment_status: 'succeeded',
    };
    expect(await expired.provider.cancelPayment(checkout.providerPaymentId)).toBe('COMPLETED');
  });

  it('keeps local PENDING when expiry fails or the remote state is unknown', async () => {
    const { provider, gateway } = setup();
    const checkout = await provider.createPayment(payment());
    gateway.failNext = new Error('synthetic timeout');
    expect(await codeOf(() => provider.cancelPayment(checkout.providerPaymentId))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
    gateway.expireResult = 'CONFLICT';
    gateway.statusAfterConflict = { checkout_status: 'open', payment_status: 'processing' };
    expect(await codeOf(() => provider.cancelPayment(checkout.providerPaymentId))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
  });
});

describe('Wave signed webhooks', () => {
  const exact = () =>
    waveCheckoutEvent({
      sessionId: FakeWaveGateway.sessionIdFor('ETP-ABCDEFGHJK23'),
      paymentReference: 'ETP-ABCDEFGHJK23',
    });

  it('verifies raw bytes with any valid v1 rotation signature', () => {
    const { provider, webhookSecret } = setup();
    const raw = exact();
    const timestamp = Math.floor(NOW / 1000);
    const valid = waveWebhookSignature(raw, webhookSecret, timestamp).split(',')[1];
    expect(
      provider.verifyWebhook(webhook(raw, `t=${timestamp},v1=${'0'.repeat(64)},${valid}`), NOW),
    ).toEqual(Buffer.from(raw));
    const altered = raw.replace('24900', '24901');
    expect(() =>
      provider.verifyWebhook(webhook(altered, `t=${timestamp},${valid}`), NOW),
    ).toThrow();
  });

  it.each([
    ['missing raw body', undefined, 'application/json', ''],
    ['empty raw body', '', 'application/json', ''],
    ['wrong content type', '{}', 'text/plain', ''],
    ['missing signature', '{}', 'application/json', ''],
    ['malformed signature', '{}', 'application/json', 't=nope,v1=bad'],
  ])('rejects %s', (_label, raw, contentType, signature) => {
    const { provider } = setup();
    const request = { ...webhook(raw, signature), contentType };
    expect(() => provider.verifyWebhook(request, NOW)).toThrow();
  });

  it('rejects oversized bodies and old/future signatures', () => {
    const { provider, webhookSecret } = setup();
    const oversized = Buffer.alloc(WAVE_MAX_PAYLOAD_BYTES + 1, 1);
    expect(() => provider.verifyWebhook(webhook(oversized, 't=1,v1=x'), NOW)).toThrow();
    const raw = exact();
    for (const timestamp of [
      Math.floor(NOW / 1000) - WAVE_SIGNATURE_TOLERANCE_SECONDS - 1,
      Math.floor(NOW / 1000) + WAVE_FUTURE_TOLERANCE_SECONDS + 1,
    ]) {
      expect(() =>
        provider.verifyWebhook(
          webhook(raw, waveWebhookSignature(raw, webhookSecret, timestamp)),
          NOW,
        ),
      ).toThrow();
    }
  });

  it('normalizes only an exact completed/succeeded event', () => {
    const { provider } = setup();
    const raw = exact();
    expect(provider.parseWebhook(Buffer.from(raw))).toMatchObject({
      type: 'PAYMENT_SUCCEEDED',
      providerPaymentId: FakeWaveGateway.sessionIdFor('ETP-ABCDEFGHJK23'),
      amountMinor: 24_900n,
      currencyCode: 'XOF',
      failureCode: null,
    });
  });

  it('accepts the official minimal completed-event shape', () => {
    const { provider } = setup();
    const minimal = JSON.stringify({
      id: 'EV_QvEZuDSQbLdI',
      type: 'checkout.session.completed',
      data: {
        id: FakeWaveGateway.sessionIdFor('ETP-ABCDEFGHJK23'),
        amount: '24900',
        currency: 'XOF',
        payment_status: 'succeeded',
        checkout_status: 'complete',
        client_reference: 'ETP-ABCDEFGHJK23',
        transaction_id: 'TCN4Y4ZC3FM',
        when_completed: '2026-10-20T12:15:00Z',
      },
    });
    expect(provider.parseWebhook(Buffer.from(minimal))).toMatchObject({
      type: 'PAYMENT_SUCCEEDED',
      amountMinor: 24_900n,
      currencyCode: 'XOF',
    });
  });

  it('ignores processing, failed and unrelated authentic events', () => {
    const { provider } = setup();
    for (const type of [
      'checkout.session.payment_failed',
      'checkout.session.processing',
      'other',
    ]) {
      expect(
        provider.parseWebhook(
          Buffer.from(
            waveCheckoutEvent({
              sessionId: FakeWaveGateway.sessionIdFor('ETP-ABCDEFGHJK23'),
              paymentReference: 'ETP-ABCDEFGHJK23',
              type,
              paymentStatus: type.includes('failed') ? 'failed' : 'processing',
            }),
          ),
        ),
      ).toBeNull();
    }
  });

  it.each([
    ['cancelled', { paymentStatus: 'cancelled' }],
    ['processing', { paymentStatus: 'processing' }],
    ['wrong checkout status', { checkoutStatus: 'open' }],
    ['wrong reference', { paymentReference: 'ETP-INVALID00000' }],
  ])('rejects completed with %s', (_label, overrides) => {
    const { provider } = setup();
    expect(() =>
      provider.parseWebhook(
        Buffer.from(
          waveCheckoutEvent({
            sessionId: FakeWaveGateway.sessionIdFor('ETP-ABCDEFGHJK23'),
            paymentReference: 'ETP-ABCDEFGHJK23',
            ...overrides,
          }),
        ),
      ),
    ).toThrow();
  });

  it('does not log secrets or raw provider bodies on failures', async () => {
    const { provider, gateway, webhookSecret, lines } = setup();
    gateway.failNext = new Error(`secret=${webhookSecret}`);
    await codeOf(() => provider.createPayment(payment()));
    const output = lines.join('\n');
    expect(output).not.toContain(webhookSecret);
    expect(output).not.toContain('secret=');
  });
});
