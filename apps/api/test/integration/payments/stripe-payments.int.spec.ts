import { createHash } from 'node:crypto';
import type { ApiEnv } from '@euroteranga/config';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  STRIPE_COLLECTION_WINDOW_SECONDS,
  STRIPE_HOLD_MARGIN_SECONDS,
} from '../../../src/payments/payment-capability.registry.js';
import { STRIPE_SIGNATURE_TOLERANCE_SECONDS } from '../../../src/payments/providers/stripe-payment.provider.js';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  syntheticCountry,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import {
  idempotencyKey,
  insertIdentityQuote,
  paymentApi,
  shortHold,
  waitUntilExpired,
} from '../../support/payment-helpers.js';
import {
  checkoutSessionEvent,
  FakeStripeGateway,
  stripeApiError,
  stripeEventId,
  stripeSignature,
  syntheticStripeSecretKey,
  syntheticStripeWebhookSecret,
  type SessionEventInput,
} from '../../support/stripe-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/** 2 seats x 124.50 EUR = 249.00 EUR, quoted in EUR for FR and ES payers. */
const UNIT = 12_450;
const TOTAL = 24_900;
const STRIPE_WEBHOOK = '/v1/payments/webhooks/stripe';

/**
 * PAY-EU-1 through the API, with Stripe in TEST mode and a fake of the
 * Stripe API calls (CI never reaches Stripe): routing, the Checkout session
 * request, signed webhooks verified by the official SDK, delayed payments,
 * returns that confirm nothing, cancellation and late results.
 */
describe('Stripe Europe adapter (isolated database, fake Stripe API)', () => {
  let t: TestApp;
  let env: ApiEnv;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let alice: CustomerActor;
  let bob: CustomerActor;
  const gateway = new FakeStripeGateway();
  const secretKey = syntheticStripeSecretKey();
  const webhookSecret = syntheticStripeWebhookSecret();

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({
      DATABASE_URL: database.url,
      // Stripe alone: no SANDBOX to fall back to.
      PAYMENT_PROVIDER: 'DISABLED',
      PAYMENT_STRIPE_MODE: 'TEST',
      PAYMENT_STRIPE_SECRET_KEY: secretKey,
      PAYMENT_STRIPE_WEBHOOK_SECRET: webhookSecret,
      // Stripe Checkout lives at least 30 minutes: the hold must outlast it.
      BOOKING_HOLD_TTL_SECONDS: '3600',
    });
    t = await startTestApp(env, [], { stripeGateway: gateway });
    countryId = await syntheticCountry(t.app);
    [alice, bob] = await Promise.all([customerActor(t.app), customerActor(t.app)]);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    gateway.onCreate = null;
    gateway.override = {};
    gateway.failNext = null;
    gateway.statusAfterExpire = 'expired';
  });

  const prisma = () => db(t.app);
  const fixture = () => bookableFixture(t.app, { countryId, amount: () => UNIT });
  const hold = async (actor: CustomerActor) => {
    const f = await fixture();
    const response = await bookingApi(actor).post('/bookings', holdBody(f, 1, 2, ['1A', '1B']));
    expect(response.status).toBe(201);
    return response.body.reference as string;
  };
  const optionsOf = async (actor: CustomerActor, reference: string, country: string) => {
    const response = await paymentApi(actor).options(reference, country);
    expect(response.status).toBe(200);
    type Option = {
      code: string;
      available: boolean;
      acceptedNetworks: string[];
      deviceWallets: string[];
    };
    const methods = response.body.methods as Option[];
    return Object.fromEntries(methods.map((method) => [method.code, method])) as Record<
      string,
      Option
    >;
  };
  /** A Stripe attempt started through the API: quote, then payment. */
  const start = async (actor: CustomerActor, method = 'CARD', country = 'FR') => {
    const reference = await hold(actor);
    const quoted = await paymentApi(actor).quote(reference, {
      payerCountry: country,
      paymentMethod: method,
    });
    expect(quoted.status).toBe(201);
    const key = idempotencyKey();
    const created = await paymentApi(actor).create(reference, {
      key,
      body: { quoteId: quoted.body.id, paymentMethod: method },
    });
    expect(created.status).toBe(201);
    const payment = await prisma().payment.findUniqueOrThrow({
      where: { reference: created.body.payment.reference },
      include: { booking: true },
    });
    return { reference, quote: quoted.body, created, payment, key };
  };
  const sessionEvent = (
    payment: { reference: string; providerPaymentId: string | null },
    overrides: Partial<SessionEventInput> = {},
  ) =>
    checkoutSessionEvent({
      sessionId: payment.providerPaymentId!,
      paymentReference: payment.reference,
      amountTotal: TOTAL,
      ...overrides,
    });
  const send = (
    raw: string,
    options: {
      secret?: string;
      /** Seconds from now, computed when sending. */
      timestampOffset?: number;
      contentType?: string;
      signature?: string | null;
    } = {},
  ) => {
    const signature =
      options.signature === undefined
        ? stripeSignature(
            raw,
            options.secret ?? webhookSecret,
            Math.floor(Date.now() / 1000) + (options.timestampOffset ?? 0),
          )
        : options.signature;
    let call = request(t.app.getHttpServer())
      .post(STRIPE_WEBHOOK)
      .set('Content-Type', options.contentType ?? 'application/json; charset=utf-8');
    if (signature !== null) call = call.set('Stripe-Signature', signature);
    return call.send(raw);
  };
  const reload = (id: string) =>
    prisma().payment.findUniqueOrThrow({ where: { id }, include: { booking: true, events: true } });

  describe('routing and payment options', () => {
    it('offers one card in France with its networks, Klarna, and nothing Stripe cannot collect', async () => {
      const reference = await hold(alice);
      const france = await optionsOf(alice, reference, 'FR');
      expect(france.CARD).toMatchObject({
        available: true,
        acceptedNetworks: ['CB', 'VISA', 'MASTERCARD', 'AMEX'],
        deviceWallets: ['APPLE_PAY', 'GOOGLE_PAY'],
      });
      expect(france.KLARNA!.available).toBe(true);
      for (const code of [
        'APPLE_PAY',
        'GOOGLE_PAY',
        'WERO',
        'ALMA',
        'SEPA_DIRECT_DEBIT',
        'SEPA_CREDIT_TRANSFER',
        'PAYPAL',
      ]) {
        expect(france[code], code).toMatchObject({
          available: false,
          acceptedNetworks: [],
          deviceWallets: [],
        });
      }
      // Network codes and Bizum are not even choices in France.
      for (const code of ['CARD_CB', 'CARD_VISA', 'CARD_MASTERCARD', 'CARD_AMEX', 'BIZUM']) {
        expect(france[code], code).toBeUndefined();
      }
    });

    it('offers card (no CB promise), Bizum and Klarna in Spain, never Wero', async () => {
      const reference = await hold(alice);
      const spain = await optionsOf(alice, reference, 'ES');
      expect(spain.CARD).toMatchObject({
        available: true,
        acceptedNetworks: ['VISA', 'MASTERCARD', 'AMEX'],
      });
      expect(spain.BIZUM!.available).toBe(true);
      expect(spain.KLARNA!.available).toBe(true);
      expect(spain.WERO).toBeUndefined();
      expect(spain.ALMA!.available).toBe(false);
    });

    it('offers nothing through Stripe in Morocco, Mauritania or Senegal', async () => {
      const reference = await hold(alice);
      for (const country of ['MA', 'MR', 'SN']) {
        const options = await optionsOf(alice, reference, country);
        for (const [code, option] of Object.entries(options)) {
          expect(option, `${country} ${code}`).toMatchObject({
            available: false,
            acceptedNetworks: [],
          });
        }
      }
      const senegal = await paymentApi(alice).quote(reference, {
        payerCountry: 'SN',
        paymentMethod: 'CARD',
      });
      expect(senegal.status).toBe(409);
      expect(senegal.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      const frenchBizum = await paymentApi(alice).quote(reference, {
        payerCountry: 'FR',
        paymentMethod: 'BIZUM',
      });
      expect(frenchBizum.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    });

    it('is unavailable when the hold could expire before the Checkout session', async () => {
      const f = await fixture();
      const needed = (STRIPE_COLLECTION_WINDOW_SECONDS + STRIPE_HOLD_MARGIN_SECONDS) * 1000;
      const short = await shortHold(t.app, f, alice.id, 1, 2, ['1A', '1B'], needed - 60_000);
      const options = await optionsOf(alice, short.reference, 'FR');
      expect(options.CARD).toMatchObject({ available: false, acceptedNetworks: [] });
      const quoted = await paymentApi(alice).quote(short.reference, {
        payerCountry: 'FR',
        paymentMethod: 'CARD',
      });
      expect(quoted.status).toBe(409);
      expect(quoted.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    });
  });

  describe('Checkout session', () => {
    it('commits PENDING first, then asks Stripe for the exact quoted amount, outside any transaction', async () => {
      const seen: Array<{ status: string | undefined; openTransactions: number }> = [];
      gateway.onCreate = async () => {
        const [row] = await prisma().payment.findMany({
          where: { provider: 'STRIPE', providerPaymentId: null },
          orderBy: { id: 'desc' },
          take: 1,
        });
        const [open] = await prisma().$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND state LIKE 'idle in transaction%'`;
        seen.push({ status: row?.status, openTransactions: Number(open!.count) });
      };
      const calls = gateway.calls.length;
      const { payment, created, quote, reference } = await start(alice);
      expect(seen).toEqual([{ status: 'PENDING', openTransactions: 0 }]);

      const call = gateway.calls[calls]!;
      expect(call.idempotencyKey).toBe(payment.reference);
      expect(call.params.allowed_payment_method_types).toEqual(['card']);
      expect(call.params.line_items).toEqual([
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: quote.presentment.amountMinor,
            product_data: { name: `Réservation ${reference}` },
          },
        },
      ]);
      expect(quote.presentment).toEqual({
        amountMinor: TOTAL,
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
      });
      expect(call.params.metadata).toEqual({ euroteranga_payment_reference: payment.reference });
      // The session closes 31 minutes after the attempt, at least 5 minutes before the hold.
      const expiresAt = call.params.expires_at! * 1000;
      expect(expiresAt).toBe(
        Math.floor((payment.createdAt.getTime() + STRIPE_COLLECTION_WINDOW_SECONDS * 1000) / 1000) *
          1000,
      );
      expect(payment.booking.holdExpiresAt.getTime() - expiresAt).toBeGreaterThanOrEqual(
        STRIPE_HOLD_MARGIN_SECONDS * 1000,
      );
      // The return pages belong to the client area, carry no secret, and confirm nothing.
      expect(call.params.success_url).toBe('http://localhost:3002/compte?paiement=retour');
      expect(call.params.cancel_url).toBe('http://localhost:3002/compte?paiement=abandon');

      expect(created.body.checkout).toEqual({
        provider: 'STRIPE',
        testMode: true,
        redirectUrl: `https://checkout.stripe.com/c/pay/${FakeStripeGateway.sessionIdFor(payment.reference)}`,
      });
      expect(payment).toMatchObject({
        status: 'PENDING',
        provider: 'STRIPE',
        providerPaymentId: FakeStripeGateway.sessionIdFor(payment.reference),
        amountMinor: BigInt(TOTAL),
      });
      expect(JSON.stringify(created.body)).not.toContain(secretKey);
    });

    it('replays the same Idempotency-Key to the same Stripe session', async () => {
      const { reference, quote, payment, key } = await start(alice);
      const before = gateway.calls.length;
      const replay = await paymentApi(alice).create(reference, {
        key,
        body: { quoteId: quote.id, paymentMethod: 'CARD' },
      });
      expect(replay.status).toBe(200);
      expect(replay.body.payment.reference).toBe(payment.reference);
      expect(gateway.calls).toHaveLength(before + 1);
      const [first, again] = gateway.calls.filter(
        (call) => call.idempotencyKey === payment.reference,
      );
      expect(again!.params).toEqual(first!.params);
      expect(await prisma().payment.count({ where: { booking: { reference } } })).toBe(1);
    });

    it('asks for a Bizum-only session in Spain, and a Klarna-only one', async () => {
      const bizum = await start(alice, 'BIZUM', 'ES');
      const klarna = await start(bob, 'KLARNA', 'FR');
      const typeOf = (reference: string) =>
        gateway.calls.find((call) => call.idempotencyKey === reference)!.params
          .allowed_payment_method_types;
      expect(typeOf(bizum.payment.reference)).toEqual(['bizum']);
      expect(typeOf(klarna.payment.reference)).toEqual(['klarna']);
    });

    it('answers PAYMENT_PROVIDER_UNAVAILABLE when Stripe refuses, and logs no secret', async () => {
      const reference = await hold(alice);
      const quoted = await paymentApi(alice).quote(reference, {
        payerCountry: 'FR',
        paymentMethod: 'CARD',
      });
      gateway.failNext = stripeApiError();
      const created = await paymentApi(alice).create(reference, {
        key: idempotencyKey(),
        body: { quoteId: quoted.body.id, paymentMethod: 'CARD' },
      });
      expect(created.status).toBe(503);
      expect(created.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      // Committed before the call, the attempt stays PENDING without a session.
      const [payment] = await prisma().payment.findMany({ where: { booking: { reference } } });
      expect(payment).toMatchObject({ status: 'PENDING', providerPaymentId: null });
      const logs = t.logs.raw.join('\n');
      expect(logs).toContain('stripe checkout session not created');
      expect(logs).not.toContain(secretKey);
      expect(logs).not.toContain(webhookSecret);
    });
  });

  describe('returns from Stripe', () => {
    it('confirm nothing: only a signed Stripe event can', async () => {
      const { payment, reference } = await start(alice);
      // The return pages are client pages; the API has no route for them.
      for (const path of [
        '/compte?paiement=retour',
        '/v1/payments/stripe/return',
        '/v1/payments/return',
      ]) {
        expect((await request(t.app.getHttpServer()).get(path)).status).toBe(404);
      }
      const list = await paymentApi(alice).list(reference);
      expect(list.body.items[0]).toMatchObject({ reference: payment.reference, status: 'PENDING' });
      const booking = await bookingApi(alice).get(`/bookings/${reference}`);
      expect(booking.body).toMatchObject({ status: 'HELD', confirmedAt: null });
    });
  });

  describe('webhook: authentication', () => {
    it.each([
      [
        'an invalid signature',
        { signature: `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` },
        401,
      ],
      ['another secret', { secret: syntheticStripeWebhookSecret() }, 401],
      ['no signature', { signature: null }, 401],
      ['an old timestamp', { timestampOffset: -301 }, 401],
      [
        'a timestamp from the future',
        { timestampOffset: STRIPE_SIGNATURE_TOLERANCE_SECONDS * 2 },
        401,
      ],
      ['another content type', { contentType: 'text/plain' }, 415],
    ] as const)('refuses %s and records nothing', async (_label, options, status) => {
      const { payment } = await start(alice);
      const response = await send(sessionEvent(payment), options);
      expect(response.status).toBe(status);
      expect(response.body.code ?? 'PAYMENT_WEBHOOK_INVALID').toBe('PAYMENT_WEBHOOK_INVALID');
      const after = await reload(payment.id);
      expect(after.status).toBe('PENDING');
      expect(after.events).toHaveLength(0);
    });

    it('refuses an oversized payload', async () => {
      const { payment } = await start(alice);
      const raw = sessionEvent(payment, { session: { padding: 'x'.repeat(33 * 1024) } });
      const response = await send(raw);
      expect(response.status).toBe(413);
      expect((await reload(payment.id)).events).toHaveLength(0);
    });

    it('answers 404 for an unknown session, so Stripe retries later', async () => {
      const raw = checkoutSessionEvent({
        sessionId: 'cs_test_unknownsession00000001',
        paymentReference: 'ETP-ABCDEFGHJK23',
        amountTotal: TOTAL,
      });
      const response = await send(raw);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('PAYMENT_NOT_FOUND');
    });
  });

  describe('webhook: results', () => {
    it('confirms the booking once on a paid session, storing only the payload hash', async () => {
      const { payment, reference } = await start(alice);
      const raw = sessionEvent(payment);
      const response = await send(raw);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, outcome: 'PAYMENT_SUCCEEDED' });
      const after = await reload(payment.id);
      expect(after.status).toBe('SUCCEEDED');
      expect(after.booking.confirmedAt).not.toBeNull();
      expect(after.events).toHaveLength(1);
      expect(after.events[0]!.payloadHash).toBe(createHash('sha256').update(raw).digest('hex'));
      const booking = await bookingApi(alice).get(`/bookings/${reference}`);
      expect(booking.body.status).toBe('CONFIRMED');

      // Stripe redelivers the very same event: acknowledged, nothing changes.
      const again = await send(raw);
      expect(again.status).toBe(200);
      expect(again.body.outcome).toBe('DUPLICATE');
      // The same event id with another payload is refused.
      const forged = JSON.parse(raw) as { id: string };
      const other = sessionEvent(payment, { eventId: forged.id, type: 'checkout.session.expired' });
      const conflict = await send(other);
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('PAYMENT_WEBHOOK_REPLAY');
      expect((await reload(payment.id)).events).toHaveLength(1);
      expect(
        await prisma().auditEvent.count({
          where: { action: 'BOOKING_CONFIRMED', resourceId: payment.bookingId },
        }),
      ).toBe(1);
    });

    it.each([
      ['amount', { amountTotal: TOTAL - 1 }, 'AMOUNT_MISMATCH'],
      ['currency', { currency: 'usd' }, 'CURRENCY_MISMATCH'],
    ] as const)(
      'records and refuses a wrong %s, changing nothing',
      async (_label, overrides, code) => {
        const { payment } = await start(alice);
        const response = await send(sessionEvent(payment, overrides));
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          received: true,
          outcome: 'REJECTED',
          code: 'PAYMENT_WEBHOOK_INVALID',
        });
        const after = await reload(payment.id);
        expect(after.status).toBe('PENDING');
        expect(after.booking.confirmedAt).toBeNull();
        expect(after.events.map((event) => event.rejectionCode)).toEqual([code]);
      },
    );

    it('fails an expired session; the booking stays held for another try', async () => {
      const { payment, reference } = await start(alice);
      const response = await send(
        sessionEvent(payment, { type: 'checkout.session.expired', paymentStatus: 'unpaid' }),
      );
      expect(response.body).toEqual({ received: true, outcome: 'PAYMENT_FAILED' });
      const after = await reload(payment.id);
      expect(after).toMatchObject({ status: 'FAILED', failureCode: 'CHECKOUT_EXPIRED' });
      expect((await bookingApi(alice).get(`/bookings/${reference}`)).body.status).toBe('HELD');
    });

    it('refuses any result for an attempt that is already terminal', async () => {
      const { payment } = await start(alice);
      expect((await send(sessionEvent(payment))).body.outcome).toBe('PAYMENT_SUCCEEDED');
      const late = await send(
        sessionEvent(payment, { type: 'checkout.session.expired', paymentStatus: 'unpaid' }),
      );
      expect(late.status).toBe(200);
      expect(late.body).toMatchObject({ outcome: 'REJECTED', code: 'PAYMENT_INVALID_TRANSITION' });
      const second = await send(sessionEvent(payment));
      expect(second.body).toMatchObject({ outcome: 'REJECTED', code: 'PAYMENT_ALREADY_SUCCEEDED' });
      const after = await reload(payment.id);
      expect(after.status).toBe('SUCCEEDED');
      expect(after.events.map((event) => event.rejectionCode)).toEqual([
        null,
        'PAYMENT_NOT_PENDING',
        'PAYMENT_ALREADY_SUCCEEDED',
      ]);
    });

    it('acknowledges events without a result: other types, sessions that are not ours', async () => {
      const { payment } = await start(alice);
      for (const raw of [
        sessionEvent(payment, { type: 'payment_intent.succeeded' }),
        sessionEvent(payment, { session: { metadata: {} } }),
      ]) {
        const response = await send(raw);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ received: true, outcome: 'IGNORED' });
      }
      expect(await reload(payment.id)).toMatchObject({ status: 'PENDING', events: [] });
    });
  });

  describe('webhook: delayed payments', () => {
    it('waits on an unpaid completed session, then applies the delayed success', async () => {
      const { payment } = await start(alice);
      const pending = await send(sessionEvent(payment, { paymentStatus: 'unpaid' }));
      expect(pending.body).toEqual({ received: true, outcome: 'IGNORED' });
      expect((await reload(payment.id)).status).toBe('PENDING');
      const later = await send(
        sessionEvent(payment, { type: 'checkout.session.async_payment_succeeded' }),
      );
      expect(later.body.outcome).toBe('PAYMENT_SUCCEEDED');
      expect((await reload(payment.id)).booking.confirmedAt).not.toBeNull();
    });

    it('fails on a delayed failure', async () => {
      const { payment } = await start(alice);
      await send(sessionEvent(payment, { paymentStatus: 'unpaid' }));
      const failed = await send(
        sessionEvent(payment, {
          type: 'checkout.session.async_payment_failed',
          paymentStatus: 'unpaid',
        }),
      );
      expect(failed.body.outcome).toBe('PAYMENT_FAILED');
      expect(await reload(payment.id)).toMatchObject({ status: 'FAILED', failureCode: 'UNKNOWN' });
    });

    it('never confirms a success that arrives after the hold expired (fail closed)', async () => {
      // A Stripe attempt whose hold ends in seconds (written under every guard),
      // standing for a webhook delayed beyond the hold.
      const f = await fixture();
      const expiring = await shortHold(t.app, f, alice.id, 1, 2, ['2A'], 3_000);
      const quote = await insertIdentityQuote(prisma(), expiring.id);
      const booking = await prisma().booking.findUniqueOrThrow({ where: { id: expiring.id } });
      const sessionId = 'cs_test_latesuccess000000001';
      const payment = await prisma().payment.create({
        data: {
          reference: 'ETP-ABCDEFGH2345',
          bookingId: booking.id,
          customerIdentityId: alice.id,
          quoteId: quote.id,
          provider: 'STRIPE',
          amountMinor: BigInt(UNIT),
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
        },
      });
      await prisma().payment.update({
        where: { id: payment.id },
        data: { providerPaymentId: sessionId },
      });
      await waitUntilExpired(t.app, expiring.id);
      const response = await send(
        checkoutSessionEvent({ sessionId, paymentReference: payment.reference, amountTotal: UNIT }),
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ outcome: 'REJECTED', code: 'PAYMENT_BOOKING_EXPIRED' });
      const after = await reload(payment.id);
      // Money may have been taken: the attempt is FAILED with its success event
      // recorded, the reconciliation evidence for a refund (stripe-europe.md).
      expect(after).toMatchObject({ status: 'FAILED', failureCode: 'BOOKING_EXPIRED' });
      expect(after.booking.confirmedAt).toBeNull();
      expect(after.events.map((event) => event.type)).toEqual(['PAYMENT_SUCCEEDED']);
    });
  });

  describe('cancellation', () => {
    it('closes the Checkout session before cancelling the attempt', async () => {
      const { payment } = await start(alice);
      const cancelled = await paymentApi(alice).cancel(payment.reference);
      expect(cancelled.status).toBe(200);
      expect(gateway.expireCalls.at(-1)).toBe(payment.providerPaymentId);
      expect((await reload(payment.id)).status).toBe('CANCELLED');
      // A payment there is now impossible; a stray event is only recorded.
      const stray = await send(sessionEvent(payment));
      expect(stray.body).toMatchObject({ outcome: 'REJECTED', code: 'PAYMENT_INVALID_TRANSITION' });
      expect((await reload(payment.id)).status).toBe('CANCELLED');
    });

    it('does not cancel an attempt the payer already completed at Stripe', async () => {
      const { payment } = await start(alice);
      gateway.statusAfterExpire = 'complete';
      const refused = await paymentApi(alice).cancel(payment.reference);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('PAYMENT_PROVIDER_COMPLETING');
      expect((await reload(payment.id)).status).toBe('PENDING');
      // Stripe's event then decides.
      expect((await send(sessionEvent(payment))).body.outcome).toBe('PAYMENT_SUCCEEDED');
    });

    it('keeps the attempt PENDING when Stripe cannot be reached', async () => {
      const { payment } = await start(alice);
      gateway.failNext = stripeApiError();
      const refused = await paymentApi(alice).cancel(payment.reference);
      expect(refused.status).toBe(503);
      expect((await reload(payment.id)).status).toBe('PENDING');
    });
  });

  describe('data protection', () => {
    it('stores no card, phone, bank or raw Stripe data, and never exposes a secret', async () => {
      const { payment, reference } = await start(alice);
      await send(sessionEvent(payment));
      const columns = await prisma().$queryRaw<Array<{ table: string; column: string }>>`
        SELECT table_name AS "table", column_name AS "column"
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('payment', 'payment_event', 'payment_quote')`;
      const names = columns.map((item) => item.column).join(' ');
      expect(names).not.toMatch(/pan|card_number|cvc|cvv|pin|otp|iban|phone|payload(?!_hash)|raw/i);
      const responses = JSON.stringify([
        (await paymentApi(alice).list(reference)).body,
        (await bookingApi(alice).get(`/bookings/${reference}`)).body,
      ]);
      expect(responses).not.toContain('cs_test_');
      expect(responses).not.toContain(secretKey);
      expect(responses).not.toContain(webhookSecret);
      const logs = t.logs.raw.join('\n');
      expect(logs).not.toContain(secretKey);
      expect(logs).not.toContain(webhookSecret);
      expect(logs).not.toContain('"object":"checkout.session"');
    });

    it('used stripeEventId-shaped ids only for synthetic events', () => {
      expect(stripeEventId()).toMatch(/^evt_[A-Za-z0-9]+$/);
    });
  });
});

describe('Stripe disabled (default)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  it('has no Stripe webhook route and routes nothing to Stripe', async () => {
    const raw = checkoutSessionEvent({
      sessionId: 'cs_test_disabled00000000001',
      paymentReference: 'ETP-ABCDEFGHJK23',
      amountTotal: TOTAL,
    });
    const response = await request(t.app.getHttpServer())
      .post(STRIPE_WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', stripeSignature(raw, syntheticStripeWebhookSecret()))
      .send(raw);
    expect(response.status).toBe(404);
  });
});
