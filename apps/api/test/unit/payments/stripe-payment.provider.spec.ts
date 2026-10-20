import { createHash } from 'node:crypto';
import { createLogger } from '@euroteranga/logger';
import { describe, expect, it } from 'vitest';
import {
  capabilityCollects,
  declaredCapability,
  PaymentCapabilityRegistry,
  PROVIDER_CAPABILITY_DECLARATIONS,
  STRIPE_COLLECTION_WINDOW_SECONDS,
  STRIPE_HOLD_MARGIN_SECONDS,
} from '../../../src/payments/payment-capability.registry.js';
import {
  PAYER_COUNTRIES,
  PAYMENT_METHOD_CODES,
  type PayerCountry,
  type PaymentMethodCode,
} from '../../../src/payments/payment-catalog.js';
import { paymentProvidersFactory } from '../../../src/payments/payment.module.js';
import type { PaymentConfig } from '../../../src/payments/payment.config.js';
import type { ProviderPaymentRequest } from '../../../src/payments/providers/payment-provider.js';
import { SandboxPaymentProvider } from '../../../src/payments/providers/sandbox-payment.provider.js';
import {
  STRIPE_MAX_PAYLOAD_BYTES,
  STRIPE_METADATA_KEY,
  StripePaymentProvider,
  StripeSdkGateway,
} from '../../../src/payments/providers/stripe-payment.provider.js';
import {
  checkoutSessionEvent,
  FakeStripeGateway,
  stripeApiError,
  stripeSignature,
  syntheticStripeSecretKey,
  syntheticStripeWebhookSecret,
} from '../../support/stripe-helpers.js';

const NOW = 1_790_000_000_000;
const RETURN_URL = 'http://localhost:3002/compte';

function captured() {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({ service: 'test', level: 'debug', write: (line) => lines.push(line) }),
  };
}

function stripeProvider(gateway = new FakeStripeGateway()) {
  const webhookSecret = syntheticStripeWebhookSecret();
  const logs = captured();
  const provider = new StripePaymentProvider({
    mode: 'TEST',
    webhookSecret,
    returnUrl: RETURN_URL,
    gateway,
    logger: logs.logger,
  });
  return { provider, gateway, webhookSecret, logs };
}

const request = (overrides: Partial<ProviderPaymentRequest> = {}): ProviderPaymentRequest => ({
  paymentReference: 'ETP-ABCDEFGHJK23',
  bookingReference: 'ETB-ABCDEFGHJK23',
  paymentMethod: 'CARD',
  payerCountry: 'FR',
  presentmentAmountMinor: 24_900n,
  presentmentCurrencyCode: 'EUR',
  presentmentCurrencyMinorUnit: 2,
  expiresAt: new Date(NOW + STRIPE_COLLECTION_WINDOW_SECONDS * 1000),
  ...overrides,
});

const codeOf = async (run: () => unknown) => {
  try {
    await run();
  } catch (error) {
    const typed = error as { getStatus?: () => number; code?: string };
    return [typed.getStatus?.(), typed.code];
  }
  return null;
};

const route = (method: PaymentMethodCode, payerCountry: PayerCountry, overrides = {}) => ({
  method,
  payerCountry,
  currencyCode: 'EUR',
  presentmentAmountMinor: 24_900n,
  holdRemainingSeconds: 3600,
  ...overrides,
});

describe('Stripe capability (PAY-EU-1)', () => {
  const stripe = declaredCapability('STRIPE');
  const registry = new PaymentCapabilityRegistry([stripeProvider().provider]);
  const routed = (...args: Parameters<typeof route>) =>
    registry.route(route(...args))?.provider.name ?? null;

  it('is restricted to France and Spain, in EUR, for CARD, BIZUM and KLARNA', () => {
    expect(stripe).toMatchObject({
      providerCode: 'STRIPE',
      payerCountries: ['FR', 'ES'],
      supportedCurrencies: ['EUR'],
      supportedMethods: ['CARD', 'BIZUM', 'KLARNA'],
      methodCountries: { BIZUM: ['ES'] },
      requiresRedirect: true,
      requiresPhone: false,
      collectionWindowSeconds: STRIPE_COLLECTION_WINDOW_SECONDS,
      minimumHoldRemainingSeconds: STRIPE_COLLECTION_WINDOW_SECONDS + STRIPE_HOLD_MARGIN_SECONDS,
    });
    // Stripe's minimum expires_at is 30 minutes after creation.
    expect(STRIPE_COLLECTION_WINDOW_SECONDS).toBeGreaterThanOrEqual(30 * 60);
    const declared = PROVIDER_CAPABILITY_DECLARATIONS.find(
      (item) => item.providerCode === 'STRIPE',
    )!;
    expect(declared.implemented).toBe(true);
  });

  it('routes CARD in France and Spain, BIZUM in Spain only, and KLARNA to Stripe', () => {
    expect(routed('CARD', 'FR')).toBe('STRIPE');
    expect(routed('CARD', 'ES')).toBe('STRIPE');
    expect(routed('BIZUM', 'ES')).toBe('STRIPE');
    expect(routed('BIZUM', 'FR')).toBeNull();
    expect(routed('KLARNA', 'FR')).toBe('STRIPE');
    expect(routed('KLARNA', 'ES')).toBe('STRIPE');
  });

  it('offers nothing in Morocco, Mauritania or Senegal, nor in another currency', () => {
    for (const country of ['MA', 'MR', 'SN'] as const) {
      for (const method of PAYMENT_METHOD_CODES) {
        expect(routed(method, country), `${method} ${country}`).toBeNull();
        expect(routed(method, country, { currencyCode: 'XOF' })).toBeNull();
      }
    }
    expect(routed('CARD', 'FR', { currencyCode: 'XOF' })).toBeNull();
  });

  it('never routes Wero, Alma, SEPA, wallets, PayPal or a card network code', () => {
    for (const country of PAYER_COUNTRIES) {
      for (const method of [
        'WERO',
        'ALMA',
        'SEPA_DIRECT_DEBIT',
        'SEPA_CREDIT_TRANSFER',
        'APPLE_PAY',
        'GOOGLE_PAY',
        'PAYPAL',
        'CARD_CB',
        'CARD_VISA',
        'CARD_MASTERCARD',
        'CARD_AMEX',
      ] as const) {
        expect(routed(method, country), `${method} ${country}`).toBeNull();
      }
    }
    expect(
      Object.fromEntries(stripe.excludedMethods.map((item) => [item.method, item.reason])),
    ).toEqual({
      APPLE_PAY: 'NOT_SELECTABLE_IN_CHECKOUT',
      GOOGLE_PAY: 'NOT_SELECTABLE_IN_CHECKOUT',
      SEPA_DIRECT_DEBIT: 'ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY',
      SEPA_CREDIT_TRANSFER: 'ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY',
      ALMA: 'BUSINESS_CATEGORY_PROHIBITED',
      WERO: 'NOT_SUPPORTED_BY_PINNED_SDK',
      PAYPAL: 'SEPARATE_PROVIDER_PR',
    });
  });

  it('respects the documented amounts: 0.50 EUR minimum, Bizum and Klarna maximums', () => {
    expect(routed('CARD', 'FR', { presentmentAmountMinor: 49n })).toBeNull();
    expect(routed('CARD', 'FR', { presentmentAmountMinor: 50n })).toBe('STRIPE');
    expect(routed('BIZUM', 'ES', { presentmentAmountMinor: 500_000n })).toBe('STRIPE');
    expect(routed('BIZUM', 'ES', { presentmentAmountMinor: 500_001n })).toBeNull();
    expect(routed('KLARNA', 'FR', { presentmentAmountMinor: 400_000n })).toBe('STRIPE');
    expect(routed('KLARNA', 'FR', { presentmentAmountMinor: 400_001n })).toBeNull();
    expect(routed('KLARNA', 'ES', { presentmentAmountMinor: 1_000_000n })).toBe('STRIPE');
    expect(routed('KLARNA', 'ES', { presentmentAmountMinor: 1_000_001n })).toBeNull();
  });

  it('starts only while the hold outlasts the Checkout session and its margin', () => {
    const needed = STRIPE_COLLECTION_WINDOW_SECONDS + STRIPE_HOLD_MARGIN_SECONDS;
    expect(routed('CARD', 'FR', { holdRemainingSeconds: needed })).toBe('STRIPE');
    expect(routed('CARD', 'FR', { holdRemainingSeconds: needed - 1 })).toBeNull();
    // The default 15-minute hold is too short for Stripe Checkout.
    expect(routed('CARD', 'FR', { holdRemainingSeconds: 900 })).toBeNull();
  });

  it('accepts CB, Visa, Mastercard and Amex cards in France; no CB promise in Spain', () => {
    expect(stripe.cardNetworks).toEqual({
      FR: ['CB', 'VISA', 'MASTERCARD', 'AMEX'],
      ES: ['VISA', 'MASTERCARD', 'AMEX'],
    });
    expect(stripe.deviceWallets).toEqual(['APPLE_PAY', 'GOOGLE_PAY']);
  });

  it('leaves days-long methods unavailable everywhere, SANDBOX included', () => {
    const sandbox = declaredCapability('SANDBOX');
    for (const method of ['SEPA_DIRECT_DEBIT', 'SEPA_CREDIT_TRANSFER'] as const) {
      expect(capabilityCollects(sandbox, route(method, 'FR'))).toBe(false);
    }
    expect(capabilityCollects(sandbox, route('BANK_TRANSFER', 'SN', { currencyCode: 'XOF' }))).toBe(
      false,
    );
    expect(capabilityCollects(sandbox, route('CARD', 'FR'))).toBe(true);
  });
});

describe('Stripe adapter: Checkout session (PAY-EU-1)', () => {
  it('asks Stripe for exactly the quoted amount, in EUR, for the chosen method only', async () => {
    const { provider, gateway } = stripeProvider();
    const checkout = await provider.createPayment(request());
    expect(gateway.calls).toHaveLength(1);
    const { params, idempotencyKey } = gateway.calls[0]!;
    expect(idempotencyKey).toBe('ETP-ABCDEFGHJK23');
    expect(params).toEqual({
      mode: 'payment',
      allowed_payment_method_types: ['card'],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: 24_900,
            product_data: { name: 'Réservation ETB-ABCDEFGHJK23' },
          },
        },
      ],
      client_reference_id: 'ETP-ABCDEFGHJK23',
      metadata: { [STRIPE_METADATA_KEY]: 'ETP-ABCDEFGHJK23' },
      payment_intent_data: { metadata: { [STRIPE_METADATA_KEY]: 'ETP-ABCDEFGHJK23' } },
      expires_at: Math.floor(NOW / 1000) + STRIPE_COLLECTION_WINDOW_SECONDS,
      success_url: `${RETURN_URL}?paiement=retour`,
      cancel_url: `${RETURN_URL}?paiement=abandon`,
    });
    expect(checkout).toEqual({
      providerPaymentId: FakeStripeGateway.sessionIdFor('ETP-ABCDEFGHJK23'),
      redirectUrl: `https://checkout.stripe.com/c/pay/${FakeStripeGateway.sessionIdFor('ETP-ABCDEFGHJK23')}`,
    });
    expect(provider.testMode).toBe(true);
  });

  it('maps each method to its single Stripe type, and replays to the same session', async () => {
    const { provider, gateway } = stripeProvider();
    await provider.createPayment(request({ paymentMethod: 'BIZUM', payerCountry: 'ES' }));
    await provider.createPayment(request({ paymentMethod: 'KLARNA' }));
    expect(gateway.calls.map((call) => call.params.allowed_payment_method_types)).toEqual([
      ['bizum'],
      ['klarna'],
    ]);
    const first = await provider.createPayment(request());
    const replay = await provider.createPayment(request());
    expect(replay).toEqual(first);
    expect(gateway.calls.at(-1)!.params).toEqual(gateway.calls.at(-2)!.params);
  });

  it('sends no personal or payment data: only the reference, the booking label and the amount', async () => {
    const { provider, gateway } = stripeProvider();
    await provider.createPayment(request());
    const sent = JSON.stringify(gateway.calls[0]!.params);
    expect(Object.keys(gateway.calls[0]!.params.metadata ?? {})).toEqual([STRIPE_METADATA_KEY]);
    expect(sent).not.toMatch(/email|phone|customer|card_number|cvc|iban|address|name":"[^R]/i);
  });

  it.each([
    'APPLE_PAY',
    'GOOGLE_PAY',
    'WERO',
    'ALMA',
    'SEPA_DIRECT_DEBIT',
    'CARD_CB',
    'WAVE_SN',
  ] as const)('refuses %s without calling Stripe: never another method', async (paymentMethod) => {
    const { provider, gateway } = stripeProvider();
    expect(await codeOf(() => provider.createPayment(request({ paymentMethod })))).toEqual([
      409,
      'PAYMENT_METHOD_UNAVAILABLE',
    ]);
    expect(gateway.calls).toHaveLength(0);
  });

  it('refuses another currency and a request without a collection deadline', async () => {
    const { provider, gateway } = stripeProvider();
    expect(
      await codeOf(() =>
        provider.createPayment(
          request({ presentmentCurrencyCode: 'XOF', presentmentCurrencyMinorUnit: 0 }),
        ),
      ),
    ).toEqual([422, 'PAYMENT_CURRENCY_UNSUPPORTED']);
    await expect(provider.createPayment(request({ expiresAt: null }))).rejects.toThrow(
      /collection deadline/,
    );
    expect(gateway.calls).toHaveLength(0);
  });

  it.each([
    ['another amount', { amountTotal: 24_901 }],
    ['another currency', { currency: 'usd' }],
    ['a live session in test mode', { livemode: true }],
    ['a page outside checkout.stripe.com', { url: 'https://checkout.example.test/pay' }],
    ['no page at all', { url: null }],
    ['a malformed session id', { id: 'pi_123' }],
  ])('refuses a session with %s', async (_label, override) => {
    const gateway = new FakeStripeGateway();
    gateway.override = override;
    const { provider } = stripeProvider(gateway);
    expect(await codeOf(() => provider.createPayment(request()))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
  });

  it('turns a Stripe error into PAYMENT_PROVIDER_UNAVAILABLE and logs only codes', async () => {
    const gateway = new FakeStripeGateway();
    gateway.failNext = stripeApiError();
    const { provider, logs } = stripeProvider(gateway);
    expect(await codeOf(() => provider.createPayment(request()))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
    expect(logs.lines).toHaveLength(1);
    const line = JSON.parse(logs.lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({
      paymentReference: 'ETP-ABCDEFGHJK23',
      stripeErrorType: 'StripeInvalidRequestError',
      stripeErrorCode: 'payment_method_unavailable',
    });
    expect(logs.lines[0]).not.toMatch(/synthetic test error|unit_amount|line_items|sk_|whsec_/);
  });

  it('closes an open session on cancellation, and reports a completed one', async () => {
    const { provider, gateway } = stripeProvider();
    expect(await provider.cancelPayment('cs_test_open00000001')).toBe('CLOSED');
    gateway.statusAfterExpire = 'complete';
    expect(await provider.cancelPayment('cs_test_paid00000001')).toBe('COMPLETED');
    gateway.statusAfterExpire = 'open';
    expect(await codeOf(() => provider.cancelPayment('cs_test_open00000002'))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
    gateway.failNext = stripeApiError();
    expect(await codeOf(() => provider.cancelPayment('cs_test_open00000003'))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
    expect(gateway.expireCalls).toHaveLength(4);
  });
});

describe('Stripe adapter: webhook authentication (PAY-EU-1)', () => {
  const event = (overrides: Partial<Parameters<typeof checkoutSessionEvent>[0]> = {}) =>
    checkoutSessionEvent({
      sessionId: 'cs_test_session0000000001',
      paymentReference: 'ETP-ABCDEFGHJK23',
      amountTotal: 24_900,
      ...overrides,
    });
  const webhook = (
    raw: string | Buffer | undefined,
    header?: string,
    contentType = 'application/json; charset=utf-8',
  ) => ({
    rawBody: raw === undefined ? undefined : Buffer.isBuffer(raw) ? raw : Buffer.from(raw),
    contentType,
    header: (name: string) => (name === 'stripe-signature' ? header : undefined),
  });

  it('accepts a payload signed with the endpoint secret (official SDK verification)', () => {
    const { provider, webhookSecret } = stripeProvider();
    const raw = event();
    const header = stripeSignature(raw, webhookSecret, NOW / 1000);
    expect(provider.verifyWebhook(webhook(raw, header), NOW).toString()).toBe(raw);
  });

  it.each([
    [
      'another secret',
      (raw: string) => stripeSignature(raw, syntheticStripeWebhookSecret(), NOW / 1000),
    ],
    ['a forged v1 signature', () => `t=${NOW / 1000},v1=${'a'.repeat(64)}`],
    ['no v1 signature', () => `t=${NOW / 1000},v0=${'a'.repeat(64)}`],
    ['an empty header', () => ''],
    ['an oversized header', () => `t=${NOW / 1000},v1=${'a'.repeat(2000)}`],
  ])('refuses a signature made with %s', async (_label, sign) => {
    const { provider } = stripeProvider();
    const raw = event();
    expect(await codeOf(() => provider.verifyWebhook(webhook(raw, sign(raw)), NOW))).toEqual([
      401,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
  });

  it('refuses a body changed after signing', async () => {
    const { provider, webhookSecret } = stripeProvider();
    const raw = event();
    const header = stripeSignature(raw, webhookSecret, NOW / 1000);
    const tampered = raw.replace('24900', '1');
    expect(await codeOf(() => provider.verifyWebhook(webhook(tampered, header), NOW))).toEqual([
      401,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
  });

  it('refuses a signature older than 5 minutes, or from more than 5 minutes ahead', async () => {
    const { provider, webhookSecret } = stripeProvider();
    const raw = event();
    const at = (offsetSeconds: number) =>
      stripeSignature(raw, webhookSecret, NOW / 1000 + offsetSeconds);
    expect(provider.verifyWebhook(webhook(raw, at(-300)), NOW).toString()).toBe(raw);
    expect(await codeOf(() => provider.verifyWebhook(webhook(raw, at(-301)), NOW))).toEqual([
      401,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
    expect(provider.verifyWebhook(webhook(raw, at(300)), NOW).toString()).toBe(raw);
    expect(await codeOf(() => provider.verifyWebhook(webhook(raw, at(301)), NOW))).toEqual([
      401,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
  });

  it('refuses another content type, an empty body and an oversized payload', async () => {
    const { provider, webhookSecret } = stripeProvider();
    const raw = event();
    const header = stripeSignature(raw, webhookSecret, NOW / 1000);
    expect(
      await codeOf(() => provider.verifyWebhook(webhook(raw, header, 'text/plain'), NOW)),
    ).toEqual([415, 'PAYMENT_WEBHOOK_INVALID']);
    expect(await codeOf(() => provider.verifyWebhook(webhook(undefined, header), NOW))).toEqual([
      400,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
    const huge = Buffer.alloc(STRIPE_MAX_PAYLOAD_BYTES + 1, 0x20);
    const hugeHeader = stripeSignature(huge.toString(), webhookSecret, NOW / 1000);
    expect(await codeOf(() => provider.verifyWebhook(webhook(huge, hugeHeader), NOW))).toEqual([
      413,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
  });

  it('logs nothing while verifying, whatever the outcome', async () => {
    const { provider, logs } = stripeProvider();
    const raw = event();
    await codeOf(() =>
      provider.verifyWebhook(webhook(raw, `t=${NOW / 1000},v1=${'b'.repeat(64)}`), NOW),
    );
    expect(logs.lines).toEqual([]);
  });
});

describe('Stripe adapter: event normalization (PAY-EU-1)', () => {
  const { provider } = stripeProvider();
  const parse = (overrides: Partial<Parameters<typeof checkoutSessionEvent>[0]> = {}) =>
    provider.parseWebhook(
      Buffer.from(
        checkoutSessionEvent({
          eventId: 'evt_testnormalization01',
          sessionId: 'cs_test_session0000000001',
          paymentReference: 'ETP-ABCDEFGHJK23',
          amountTotal: 24_900,
          ...overrides,
        }),
      ),
    );

  it('turns a paid completed session into a success, with the collected amount and its hash', () => {
    const raw = Buffer.from(
      checkoutSessionEvent({
        eventId: 'evt_testnormalization01',
        sessionId: 'cs_test_session0000000001',
        paymentReference: 'ETP-ABCDEFGHJK23',
        amountTotal: 24_900,
      }),
    );
    expect(provider.parseWebhook(raw)).toEqual({
      providerEventId: 'evt_testnormalization01',
      type: 'PAYMENT_SUCCEEDED',
      failureCode: null,
      providerPaymentId: 'cs_test_session0000000001',
      amountMinor: 24_900n,
      currencyCode: 'EUR',
      payloadHash: createHash('sha256').update(raw).digest('hex'),
    });
  });

  it('waits for the result of a delayed payment, then applies its success or failure', () => {
    expect(parse({ paymentStatus: 'unpaid' })).toBeNull();
    expect(parse({ type: 'checkout.session.async_payment_succeeded' })).toMatchObject({
      type: 'PAYMENT_SUCCEEDED',
    });
    expect(
      parse({ type: 'checkout.session.async_payment_succeeded', paymentStatus: 'unpaid' }),
    ).toBeNull();
    expect(
      parse({ type: 'checkout.session.async_payment_failed', paymentStatus: 'unpaid' }),
    ).toMatchObject({ type: 'PAYMENT_FAILED', failureCode: 'UNKNOWN' });
  });

  it('fails an expired session', () => {
    expect(parse({ type: 'checkout.session.expired', paymentStatus: 'unpaid' })).toMatchObject({
      type: 'PAYMENT_FAILED',
      failureCode: 'CHECKOUT_EXPIRED',
      amountMinor: 24_900n,
    });
  });

  it('ignores other event types and sessions that are not ours', () => {
    expect(parse({ type: 'payment_intent.succeeded' })).toBeNull();
    expect(parse({ type: 'charge.refunded' })).toBeNull();
    expect(parse({ session: { metadata: {} } })).toBeNull();
    expect(parse({ session: { metadata: null } })).toBeNull();
    expect(parse({ session: { client_reference_id: 'ETP-OTHERREF2345' } })).toBeNull();
    expect(parse({ paymentReference: 'not-a-reference' })).toBeNull();
  });

  it('refuses a live event in test mode, and malformed payloads', async () => {
    expect(await codeOf(() => parse({ livemode: true }))).toEqual([400, 'PAYMENT_WEBHOOK_INVALID']);
    expect(await codeOf(() => parse({ session: { livemode: true } }))).toEqual([
      400,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
    expect(await codeOf(() => parse({ session: { amount_total: -1 } }))).toEqual([
      400,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
    expect(await codeOf(() => parse({ sessionId: 'pi_not_a_session' }))).toEqual([
      400,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
    expect(await codeOf(() => provider.parseWebhook(Buffer.from('{not json')))).toEqual([
      400,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
    expect(await codeOf(() => provider.parseWebhook(Buffer.from('{"id":"evt_x"}')))).toEqual([
      400,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
  });
});

describe('Stripe wiring (PAY-EU-1)', () => {
  const base: PaymentConfig = {
    provider: 'DISABLED',
    sandboxWebhookKey: null,
    stripe: null,
    paypal: null,
    wave: null,
    returnUrl: RETURN_URL,
  };
  const { logger } = captured();

  it('wires nothing while DISABLED: no adapter, no client, no network', () => {
    expect(paymentProvidersFactory(base, logger, null)).toEqual([]);
  });

  it('wires Stripe in TEST next to SANDBOX, each with its own capability', () => {
    const providers = paymentProvidersFactory(
      {
        ...base,
        provider: 'SANDBOX',
        sandboxWebhookKey: Buffer.alloc(32, 7),
        stripe: {
          mode: 'TEST',
          secretKey: syntheticStripeSecretKey(),
          webhookSecret: syntheticStripeWebhookSecret(),
        },
      },
      logger,
      new FakeStripeGateway(),
    );
    expect(providers.map((item) => item.name)).toEqual(['SANDBOX', 'STRIPE']);
    expect(providers[0]).toBeInstanceOf(SandboxPaymentProvider);
    expect(providers[1]).toBeInstanceOf(StripePaymentProvider);
    expect(providers[1]!.testMode).toBe(true);
    const registry = new PaymentCapabilityRegistry(providers);
    // Stripe is preferred for cards in France; SANDBOX still collects the rest.
    expect(registry.route(route('CARD', 'FR'))?.provider.name).toBe('STRIPE');
    expect(registry.route(route('WAVE_SN', 'SN', { currencyCode: 'XOF' }))?.provider.name).toBe(
      'SANDBOX',
    );
  });

  it('builds the official SDK client without any network call', () => {
    // Constructing the client sends nothing; only an API call would.
    expect(() => new StripeSdkGateway(syntheticStripeSecretKey())).not.toThrow();
  });

  it('never starts LIVE, even if the configuration let it through', () => {
    expect(() =>
      paymentProvidersFactory(
        {
          ...base,
          stripe: {
            mode: 'LIVE',
            secretKey: `sk_${'live'}_${'0'.repeat(24)}`,
            webhookSecret: syntheticStripeWebhookSecret(),
          },
        },
        logger,
        new FakeStripeGateway(),
      ),
    ).toThrow(/LIVE is not enabled/);
  });
});
