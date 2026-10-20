import { createHash } from 'node:crypto';
import { createLogger } from '@euroteranga/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  declaredCapability,
  PaymentCapabilityRegistry,
  PAYPAL_START_HOLD_SECONDS,
  PROVIDER_CAPABILITY_DECLARATIONS,
} from '../../../src/payments/payment-capability.registry.js';
import {
  PAYMENT_METHOD_BY_CODE,
  PAYMENT_METHOD_CODES,
  type PayerCountry,
} from '../../../src/payments/payment-catalog.js';
import type { PaymentConfig } from '../../../src/payments/payment.config.js';
import { paymentProvidersFactory } from '../../../src/payments/payment.module.js';
import { captureIdempotencyKey } from '../../../src/payments/payment-rules.js';
import type { ProviderPaymentRequest } from '../../../src/payments/providers/payment-provider.js';
import {
  eurMinorToValue,
  eurValueToMinor,
  PAYPAL_MAX_PAYLOAD_BYTES,
  PayPalPaymentProvider,
  PayPalRequestError,
  PayPalSdkGateway,
} from '../../../src/payments/providers/paypal-payment.provider.js';
import {
  approvalReversedEvent,
  captureEvent,
  FakePayPalGateway,
  orderApprovedEvent,
  orderIdFor,
  paypalTransmissionHeaders,
  syntheticPayPalClientId,
  syntheticPayPalClientSecret,
  syntheticPayPalWebhookId,
} from '../../support/paypal-helpers.js';

const RETURN_URL = 'http://localhost:3002/compte';
const REFERENCE = 'ETP-ABCDEFGHJK23';

function captured() {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({ service: 'test', level: 'debug', write: (line) => lines.push(line) }),
  };
}

function paypalProvider(gateway = new FakePayPalGateway(), mode: 'SANDBOX' | 'LIVE' = 'SANDBOX') {
  const logs = captured();
  const webhookId = syntheticPayPalWebhookId();
  const provider = new PayPalPaymentProvider({
    mode,
    webhookId,
    returnUrl: RETURN_URL,
    gateway,
    logger: logs.logger,
  });
  return { provider, gateway, logs, webhookId };
}

const request = (overrides: Partial<ProviderPaymentRequest> = {}): ProviderPaymentRequest => ({
  paymentReference: REFERENCE,
  bookingReference: 'ETB-ABCDEFGHJK23',
  paymentMethod: 'PAYPAL',
  payerCountry: 'FR',
  presentmentAmountMinor: 24_900n,
  presentmentCurrencyCode: 'EUR',
  presentmentCurrencyMinorUnit: 2,
  expiresAt: null,
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

const route = (method: string, payerCountry: PayerCountry, overrides = {}) => ({
  method: method as 'PAYPAL',
  payerCountry,
  currencyCode: 'EUR',
  presentmentAmountMinor: 24_900n,
  holdRemainingSeconds: 900,
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe('PayPal capability (PAY-PAYPAL-1)', () => {
  const registry = new PaymentCapabilityRegistry([paypalProvider().provider]);
  const routed = (...args: Parameters<typeof route>) =>
    registry.route(route(...args))?.provider.name ?? null;

  it('collects PAYPAL for payers in France and Spain, in EUR, and is implemented', () => {
    expect(declaredCapability('PAYPAL')).toMatchObject({
      providerCode: 'PAYPAL',
      supportedMethods: ['PAYPAL'],
      payerCountries: ['FR', 'ES'],
      supportedCurrencies: ['EUR'],
      requiresRedirect: true,
      localCancelPreventsCollection: true,
      collectionWindowSeconds: null,
      minimumHoldRemainingSeconds: PAYPAL_START_HOLD_SECONDS,
    });
    expect(
      PROVIDER_CAPABILITY_DECLARATIONS.find((item) => item.providerCode === 'PAYPAL')!.implemented,
    ).toBe(true);
    expect(routed('PAYPAL', 'FR')).toBe('PAYPAL');
    expect(routed('PAYPAL', 'ES')).toBe('PAYPAL');
  });

  it('never routes Senegal, Morocco or Mauritania, nor XOF, MAD or MRU', () => {
    for (const country of ['SN', 'MA', 'MR'] as const) {
      expect(routed('PAYPAL', country), country).toBeNull();
    }
    for (const currencyCode of ['XOF', 'MAD', 'MRU']) {
      for (const country of ['FR', 'ES', 'SN'] as const) {
        expect(
          routed('PAYPAL', country, { currencyCode }),
          `${currencyCode} ${country}`,
        ).toBeNull();
      }
    }
    // The catalogue may keep PayPal as a future intention in Senegal.
    expect(PAYMENT_METHOD_BY_CODE.get('PAYPAL')!.countries).toContain('SN');
  });

  it('collects no other method', () => {
    for (const method of PAYMENT_METHOD_CODES.filter((code) => code !== 'PAYPAL')) {
      expect(routed(method, 'FR'), method).toBeNull();
    }
  });

  it('works with the default 15-minute hold, and needs two minutes to start', () => {
    expect(routed('PAYPAL', 'FR', { holdRemainingSeconds: 900 })).toBe('PAYPAL');
    expect(routed('PAYPAL', 'FR', { holdRemainingSeconds: PAYPAL_START_HOLD_SECONDS })).toBe(
      'PAYPAL',
    );
    expect(
      routed('PAYPAL', 'FR', { holdRemainingSeconds: PAYPAL_START_HOLD_SECONDS - 1 }),
    ).toBeNull();
  });

  it('keeps Stripe needing its own checkout closed before a local cancellation', () => {
    expect(declaredCapability('STRIPE').localCancelPreventsCollection).toBe(false);
    expect(declaredCapability('SANDBOX').localCancelPreventsCollection).toBe(true);
  });
});

describe('PayPal amounts (no floating point)', () => {
  it.each([
    [24_900n, '249.00'],
    [1n, '0.01'],
    [10n, '0.10'],
    [100n, '1.00'],
    [123_456_789_012_345_67n, '123456789012345.67'],
  ])('writes %s minor units as "%s"', (minor, value) => {
    expect(eurMinorToValue(minor)).toBe(value);
    expect(eurValueToMinor(value)).toBe(minor);
  });

  it('refuses a non-positive amount and any value that is not exactly two decimals', () => {
    expect(() => eurMinorToValue(0n)).toThrow(/positive/);
    expect(() => eurMinorToValue(-1n)).toThrow(/positive/);
    for (const value of ['249', '249.0', '249.001', '-1.00', '01.00', '1e3', ' 1.00', '1,00', '']) {
      expect(eurValueToMinor(value), value).toBeNull();
    }
  });
});

describe('PayPal adapter: Create Order', () => {
  it('creates a CAPTURE order of exactly the quoted EUR amount, keyed on the payment reference', async () => {
    const { provider, gateway } = paypalProvider();
    const checkout = await provider.createPayment(request());
    expect(gateway.createCalls).toEqual([
      {
        requestId: REFERENCE,
        body: {
          intent: 'CAPTURE',
          purchaseUnits: [
            {
              amount: { currencyCode: 'EUR', value: '249.00' },
              customId: REFERENCE,
              description: 'Réservation ETB-ABCDEFGHJK23',
            },
          ],
          paymentSource: {
            paypal: {
              experienceContext: {
                returnUrl: `${RETURN_URL}?paiement=retour`,
                cancelUrl: `${RETURN_URL}?paiement=abandon`,
                shippingPreference: 'NO_SHIPPING',
                userAction: 'PAY_NOW',
                paymentMethodPreference: 'IMMEDIATE_PAYMENT_REQUIRED',
              },
            },
          },
        },
      },
    ]);
    const orderId = orderIdFor(REFERENCE);
    expect(checkout).toEqual({
      providerPaymentId: orderId,
      redirectUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
    });
    expect(provider.testMode).toBe(true);
    // A replay asks for the same order.
    expect(await provider.createPayment(request())).toEqual(checkout);
    expect(gateway.createCalls[1]!.requestId).toBe(REFERENCE);
  });

  it('sends no personal data: no payer, e-mail, phone, address or shipping', async () => {
    const { provider, gateway } = paypalProvider();
    await provider.createPayment(request({ payerCountry: 'ES' }));
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.push(key);
          walk(inner);
        }
      }
    };
    walk(gateway.createCalls[0]!.body);
    for (const forbidden of [
      'payer',
      'emailAddress',
      'phone',
      'address',
      'name',
      'shipping',
      'birthDate',
      'taxInfo',
      'items',
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it.each([
    ['another method', { paymentMethod: 'CARD' as const }, [409, 'PAYMENT_METHOD_UNAVAILABLE']],
    ['Senegal', { payerCountry: 'SN' as const }, [422, 'PAYMENT_COUNTRY_UNSUPPORTED']],
    ['Morocco', { payerCountry: 'MA' as const }, [422, 'PAYMENT_COUNTRY_UNSUPPORTED']],
    [
      'XOF',
      { presentmentCurrencyCode: 'XOF', presentmentCurrencyMinorUnit: 0 },
      [422, 'PAYMENT_CURRENCY_UNSUPPORTED'],
    ],
  ])('refuses %s without calling PayPal', async (_label, overrides, code) => {
    const { provider, gateway } = paypalProvider();
    expect(await codeOf(() => provider.createPayment(request(overrides)))).toEqual(code);
    expect(gateway.createCalls).toHaveLength(0);
  });

  const hostile = (id: string) =>
    [
      [
        'no payer-action link',
        [{ rel: 'approve', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
      ],
      [
        'a foreign host',
        [{ rel: 'payer-action', href: `https://checkout.example.test/checkoutnow?token=${id}` }],
      ],
      [
        'a look-alike host',
        [
          {
            rel: 'payer-action',
            href: `https://www.sandbox.paypal.com.example.test/checkoutnow?token=${id}`,
          },
        ],
      ],
      [
        'the live host in SANDBOX',
        [{ rel: 'payer-action', href: `https://www.paypal.com/checkoutnow?token=${id}` }],
      ],
      [
        'plain http',
        [{ rel: 'payer-action', href: `http://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
      ],
      [
        'credentials in the URL',
        [
          {
            rel: 'payer-action',
            href: `https://u:p@www.sandbox.paypal.com/checkoutnow?token=${id}`,
          },
        ],
      ],
      [
        'another path',
        [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/signin?token=${id}` }],
      ],
      [
        'another order token',
        [
          {
            rel: 'payer-action',
            href: 'https://www.sandbox.paypal.com/checkoutnow?token=OTHER123',
          },
        ],
      ],
      [
        'an extra parameter',
        [
          {
            rel: 'payer-action',
            href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}&next=https://evil.example.test`,
          },
        ],
      ],
      [
        'a port',
        [
          {
            rel: 'payer-action',
            href: `https://www.sandbox.paypal.com:8443/checkoutnow?token=${id}`,
          },
        ],
      ],
      [
        'two payer-action links',
        [
          { rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` },
          { rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` },
        ],
      ],
      ['not a URL', [{ rel: 'payer-action', href: 'javascript:alert(1)' }]],
    ] as const;

  it.each(hostile(orderIdFor(REFERENCE)))(
    'refuses an approval link with %s',
    async (_label, links) => {
      const gateway = new FakePayPalGateway();
      gateway.links = links.map((link) => ({ ...link }));
      const { provider } = paypalProvider(gateway);
      expect(await codeOf(() => provider.createPayment(request()))).toEqual([
        503,
        'PAYMENT_PROVIDER_UNAVAILABLE',
      ]);
    },
  );

  it('expects the live approval host in LIVE', async () => {
    const gateway = new FakePayPalGateway();
    gateway.host = 'www.paypal.com';
    const { provider } = paypalProvider(gateway, 'LIVE');
    expect((await provider.createPayment(request())).redirectUrl).toMatch(
      /^https:\/\/www\.paypal\.com\/checkoutnow\?token=/,
    );
    expect(provider.testMode).toBe(false);
  });

  it('refuses a malformed order id', async () => {
    const gateway: FakePayPalGateway = new FakePayPalGateway();
    vi.spyOn(gateway, 'createOrder').mockResolvedValue({
      id: 'not-an-order-id',
      status: 'PAYER_ACTION_REQUIRED',
      links: [
        {
          rel: 'payer-action',
          href: 'https://www.sandbox.paypal.com/checkoutnow?token=not-an-order-id',
        },
      ],
    });
    const { provider } = paypalProvider(gateway);
    expect(await codeOf(() => provider.createPayment(request()))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
  });

  it('turns a PayPal error into PAYMENT_PROVIDER_UNAVAILABLE and logs only codes', async () => {
    const gateway = new FakePayPalGateway();
    gateway.failNext = new PayPalRequestError(400, 'INVALID_PARAMETER_VALUE', 'dbg-123');
    const { provider, logs } = paypalProvider(gateway);
    expect(await codeOf(() => provider.createPayment(request()))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
    expect(JSON.parse(logs.lines[0]!)).toMatchObject({
      paymentReference: REFERENCE,
      paypalStatusCode: 400,
      paypalIssue: 'INVALID_PARAMETER_VALUE',
      paypalDebugId: 'dbg-123',
    });
    expect(logs.lines.join('\n')).not.toMatch(/249\.00|customId|Authorization|Bearer/);
  });
});

describe('PayPal adapter: Capture Order', () => {
  const ready = async () => {
    const setup = paypalProvider();
    const { providerPaymentId } = await setup.provider.createPayment(request());
    return { ...setup, orderId: providerPaymentId };
  };

  it('captures with the deterministic key; the same approval twice is the same capture', async () => {
    const { provider, gateway, orderId } = await ready();
    const key = captureIdempotencyKey(REFERENCE);
    expect(key).toBe(`${REFERENCE}-CAPTURE`);
    expect(key.length).toBeLessThanOrEqual(38);
    expect(await provider.capturePayment(orderId, key)).toBe('CAPTURE_REQUESTED');
    expect(await provider.capturePayment(orderId, key)).toBe('CAPTURE_REQUESTED');
    expect(gateway.captureCalls).toEqual([
      { orderId, requestId: key },
      { orderId, requestId: key },
    ]);
    expect(gateway.captures.get(orderId)).toBe(1);
  });

  it('treats an order already captured as resolved, never as a new capture', async () => {
    const { provider, gateway, orderId } = await ready();
    await provider.capturePayment(orderId, captureIdempotencyKey(REFERENCE));
    // PayPal's answer to another key on a captured order.
    expect(await provider.capturePayment(orderId, 'ETP-OTHERKEY0000-CAPTURE')).toBe(
      'ALREADY_CAPTURED',
    );
    expect(gateway.captures.get(orderId)).toBe(1);
  });

  it('reports a capture PayPal refuses, and keeps an unknown outcome unknown', async () => {
    const { provider, gateway, orderId, logs } = await ready();
    gateway.failNext = new PayPalRequestError(422, 'INSTRUMENT_DECLINED', 'dbg-1');
    expect(await provider.capturePayment(orderId, captureIdempotencyKey(REFERENCE))).toBe(
      'NOT_CAPTURABLE',
    );
    // A timeout: the outcome at PayPal is unknown; the approval will be redelivered.
    gateway.failNext = new PayPalRequestError(null, null, null);
    expect(
      await codeOf(() => provider.capturePayment(orderId, captureIdempotencyKey(REFERENCE))),
    ).toEqual([503, 'PAYMENT_PROVIDER_UNAVAILABLE']);
    expect(logs.lines.join('\n')).toContain('INSTRUMENT_DECLINED');
    expect(
      await codeOf(() => provider.capturePayment('bad id', captureIdempotencyKey(REFERENCE))),
    ).toEqual([404, 'PAYMENT_NOT_FOUND']);
  });
});

describe('PayPal adapter: webhook authentication', () => {
  const webhook = (
    raw: string | Buffer | undefined,
    headers: Record<string, string> = paypalTransmissionHeaders(),
    contentType = 'application/json',
  ) => ({
    rawBody: raw === undefined ? undefined : Buffer.isBuffer(raw) ? raw : Buffer.from(raw),
    contentType,
    header: (name: string) =>
      Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1],
  });

  it('asks PayPal to verify the event, posted back unchanged with our webhook ID', async () => {
    const { provider, gateway, webhookId } = paypalProvider();
    const raw = orderApprovedEvent({ orderId: 'ORDER1234567890' });
    const headers = paypalTransmissionHeaders();
    expect((await provider.verifyWebhook(webhook(raw, headers), Date.now())).toString()).toBe(raw);
    expect(gateway.verifyCalls).toHaveLength(1);
    const body = gateway.verifyCalls[0]!;
    // webhook_event is the exact raw body, byte for byte.
    expect(body.endsWith(`,"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(body)).toEqual({
      auth_algo: headers['PAYPAL-AUTH-ALGO'],
      cert_url: headers['PAYPAL-CERT-URL'],
      transmission_id: headers['PAYPAL-TRANSMISSION-ID'],
      transmission_sig: headers['PAYPAL-TRANSMISSION-SIG'],
      transmission_time: headers['PAYPAL-TRANSMISSION-TIME'],
      webhook_id: webhookId,
      webhook_event: JSON.parse(raw),
    });
  });

  it('never fetches PAYPAL-CERT-URL itself', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { provider } = paypalProvider();
    await provider.verifyWebhook(
      webhook(orderApprovedEvent({ orderId: 'ORDER1234567890' })),
      Date.now(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    'PAYPAL-AUTH-ALGO',
    'PAYPAL-CERT-URL',
    'PAYPAL-TRANSMISSION-ID',
    'PAYPAL-TRANSMISSION-SIG',
    'PAYPAL-TRANSMISSION-TIME',
  ])('refuses an event without %s, before asking PayPal', async (missing) => {
    const { provider, gateway } = paypalProvider();
    const headers: Record<string, string> = paypalTransmissionHeaders();
    delete headers[missing];
    expect(
      await codeOf(() =>
        provider.verifyWebhook(
          webhook(orderApprovedEvent({ orderId: 'ORDER1234567890' }), headers),
          Date.now(),
        ),
      ),
    ).toEqual([401, 'PAYMENT_WEBHOOK_INVALID']);
    expect(gateway.verifyCalls).toHaveLength(0);
  });

  it.each([
    ['an oversized signature', { 'PAYPAL-TRANSMISSION-SIG': `s${'a'.repeat(600)}` }],
    ['an oversized transmission id', { 'PAYPAL-TRANSMISSION-ID': `t${'1'.repeat(60)}` }],
    [
      'a non-https certificate URL',
      { 'PAYPAL-CERT-URL': 'http://api.paypal.com/v1/notifications/certs/CERT-1' },
    ],
    [
      'an oversized certificate URL',
      { 'PAYPAL-CERT-URL': `https://api.paypal.com/${'a'.repeat(500)}` },
    ],
    ['a malformed algorithm', { 'PAYPAL-AUTH-ALGO': 'SHA256 withRSA' }],
    ['a malformed time', { 'PAYPAL-TRANSMISSION-TIME': 'yesterday' }],
  ])('refuses %s', async (_label, override) => {
    const { provider, gateway } = paypalProvider();
    expect(
      await codeOf(() =>
        provider.verifyWebhook(
          webhook(
            orderApprovedEvent({ orderId: 'ORDER1234567890' }),
            paypalTransmissionHeaders(override),
          ),
          Date.now(),
        ),
      ),
    ).toEqual([401, 'PAYMENT_WEBHOOK_INVALID']);
    expect(gateway.verifyCalls).toHaveLength(0);
  });

  it('refuses another content type, an empty, oversized or non-object body', async () => {
    const { provider, gateway } = paypalProvider();
    const raw = orderApprovedEvent({ orderId: 'ORDER1234567890' });
    expect(
      await codeOf(() => provider.verifyWebhook(webhook(raw, undefined, 'text/plain'), 0)),
    ).toEqual([415, 'PAYMENT_WEBHOOK_INVALID']);
    expect(await codeOf(() => provider.verifyWebhook(webhook(undefined), 0))).toEqual([
      400,
      'PAYMENT_WEBHOOK_INVALID',
    ]);
    expect(
      await codeOf(() =>
        provider.verifyWebhook(webhook(Buffer.alloc(PAYPAL_MAX_PAYLOAD_BYTES + 1, 0x20)), 0),
      ),
    ).toEqual([413, 'PAYMENT_WEBHOOK_INVALID']);
    for (const body of ['[1,2]', '"text"', '{not json', 'null']) {
      expect(await codeOf(() => provider.verifyWebhook(webhook(body), 0)), body).toEqual([
        400,
        'PAYMENT_WEBHOOK_INVALID',
      ]);
    }
    expect(gateway.verifyCalls).toHaveLength(0);
  });

  it('refuses an event PayPal does not verify', async () => {
    const gateway = new FakePayPalGateway();
    gateway.verification = 'FAILURE';
    const { provider } = paypalProvider(gateway);
    expect(
      await codeOf(() =>
        provider.verifyWebhook(webhook(orderApprovedEvent({ orderId: 'ORDER1234567890' })), 0),
      ),
    ).toEqual([401, 'PAYMENT_WEBHOOK_INVALID']);
  });

  it('fails closed (503, redelivered) when the verification cannot complete, logging no payload', async () => {
    const gateway = new FakePayPalGateway();
    gateway.failNext = new PayPalRequestError(null, null, null);
    const { provider, logs } = paypalProvider(gateway);
    const raw = orderApprovedEvent({ orderId: 'ORDER1234567890' });
    expect(await codeOf(() => provider.verifyWebhook(webhook(raw), 0))).toEqual([
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    ]);
    expect(logs.lines.join('\n')).not.toContain('ORDER1234567890');
    expect(logs.lines.join('\n')).not.toContain('CHECKOUT.ORDER.APPROVED');
  });
});

describe('PayPal adapter: event normalization (official samples)', () => {
  const { provider } = paypalProvider();
  const parse = (raw: string) => provider.parseWebhook(Buffer.from(raw));
  const ORDER = 'ORDER1234567890';

  it('reads an approval, which is never a payment result', () => {
    const raw = orderApprovedEvent({ orderId: ORDER, eventId: 'WH-1HN0997948621344U-TEST' });
    expect(parse(raw)).toEqual({
      type: 'PAYMENT_APPROVED',
      providerEventId: 'WH-1HN0997948621344U-TEST',
      providerPaymentId: ORDER,
      amountMinor: 24_900n,
      currencyCode: 'EUR',
      payloadHash: createHash('sha256').update(raw).digest('hex'),
    });
    expect(parse(orderApprovedEvent({ orderId: ORDER, amount: null }))).toMatchObject({
      type: 'PAYMENT_APPROVED',
      amountMinor: null,
      currencyCode: null,
    });
    // Only our CAPTURE orders.
    expect(parse(orderApprovedEvent({ orderId: ORDER, intent: 'AUTHORIZE' }))).toBeNull();
  });

  it('succeeds only on PAYMENT.CAPTURE.COMPLETED, correlated by related_ids.order_id', () => {
    expect(
      parse(captureEvent({ type: 'PAYMENT.CAPTURE.COMPLETED', orderId: ORDER })),
    ).toMatchObject({
      type: 'PAYMENT_SUCCEEDED',
      providerPaymentId: ORDER,
      amountMinor: 24_900n,
      currencyCode: 'EUR',
      failureCode: null,
    });
    // No documented order id: never guessed.
    expect(() =>
      parse(captureEvent({ type: 'PAYMENT.CAPTURE.COMPLETED', orderId: ORDER, relatedIds: null })),
    ).toThrow();
    expect(() =>
      parse(captureEvent({ type: 'PAYMENT.CAPTURE.COMPLETED', orderId: ORDER, status: 'PENDING' })),
    ).toThrow();
  });

  it('waits on PAYMENT.CAPTURE.PENDING and ignores refunds and unknown events', () => {
    expect(parse(captureEvent({ type: 'PAYMENT.CAPTURE.PENDING', orderId: ORDER }))).toBeNull();
    expect(parse(captureEvent({ type: 'PAYMENT.CAPTURE.REFUNDED', orderId: ORDER }))).toBeNull();
    expect(
      parse(
        JSON.stringify({
          id: 'WH-00000000000-TEST',
          event_type: 'BILLING.PLAN.CREATED',
          resource: {},
        }),
      ),
    ).toBeNull();
  });

  it('fails on a denied or declined capture, and on a reversed approval (no amount)', () => {
    for (const type of ['PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED'] as const) {
      expect(parse(captureEvent({ type, orderId: ORDER }))).toMatchObject({
        type: 'PAYMENT_FAILED',
        failureCode: 'DECLINED',
        providerPaymentId: ORDER,
        amountMinor: 24_900n,
      });
    }
    expect(parse(approvalReversedEvent({ orderId: ORDER }))).toMatchObject({
      type: 'PAYMENT_FAILED',
      failureCode: 'CHECKOUT_EXPIRED',
      providerPaymentId: ORDER,
      amountMinor: null,
      currencyCode: null,
    });
  });

  it('keeps another currency readable so it can be refused as a mismatch', () => {
    expect(
      parse(captureEvent({ type: 'PAYMENT.CAPTURE.COMPLETED', orderId: ORDER, currency: 'USD' })),
    ).toMatchObject({ currencyCode: 'USD', amountMinor: 24_900n });
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['a bad event id', orderApprovedEvent({ orderId: ORDER, eventId: 'evt_1' })],
    ['a bad order id', orderApprovedEvent({ orderId: 'order-1' })],
    [
      'an amount that is not two decimals',
      captureEvent({ type: 'PAYMENT.CAPTURE.COMPLETED', orderId: ORDER, value: '249' }),
    ],
    [
      'a reversal without order id',
      JSON.stringify({
        id: 'WH-00000000000-TEST',
        event_type: 'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
        resource: {},
      }),
    ],
  ])('refuses %s', async (_label, raw) => {
    expect(await codeOf(() => parse(raw))).toEqual([400, 'PAYMENT_WEBHOOK_INVALID']);
  });
});

describe('PayPal wiring (PAY-PAYPAL-1)', () => {
  const base: PaymentConfig = {
    provider: 'DISABLED',
    sandboxWebhookKey: null,
    stripe: null,
    paypal: null,
    wave: null,
    returnUrl: RETURN_URL,
  };
  const { logger } = captured();
  const paypal = (mode: 'SANDBOX' | 'LIVE') => ({
    mode,
    clientId: syntheticPayPalClientId(),
    clientSecret: syntheticPayPalClientSecret(),
    webhookId: syntheticPayPalWebhookId(),
  });

  it('wires nothing while DISABLED', () => {
    expect(paymentProvidersFactory(base, logger, null, null)).toEqual([]);
  });

  it('wires PayPal in SANDBOX next to SANDBOX payments, test mode', () => {
    const providers = paymentProvidersFactory(
      {
        ...base,
        provider: 'SANDBOX',
        sandboxWebhookKey: Buffer.alloc(32, 3),
        paypal: paypal('SANDBOX'),
      },
      logger,
      null,
      new FakePayPalGateway(),
    );
    expect(providers.map((item) => item.name)).toEqual(['SANDBOX', 'PAYPAL']);
    expect(providers[1]).toBeInstanceOf(PayPalPaymentProvider);
    expect(providers[1]!.testMode).toBe(true);
  });

  it('builds the official SDK client without any network call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { clientId, clientSecret } = paypal('SANDBOX');
    expect(() => new PayPalSdkGateway('SANDBOX', clientId, clientSecret)).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never starts LIVE, even if the configuration let it through', () => {
    expect(() =>
      paymentProvidersFactory(
        { ...base, paypal: paypal('LIVE') },
        logger,
        null,
        new FakePayPalGateway(),
      ),
    ).toThrow(/LIVE is not enabled/);
  });
});
