import { createHash } from 'node:crypto';
import type { ApiEnv } from '@euroteranga/config';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PAYMENT_CAPTURE_REQUESTED } from '../../../src/payments/payment-webhook.service.js';
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
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/** 2 seats x 124.50 EUR = 249.00 EUR. */
const UNIT = 12_450;
const TOTAL = 24_900;
const PAYPAL_WEBHOOK = '/v1/payments/webhooks/paypal';

/**
 * PAY-PAYPAL-1 through the API, with PayPal in SANDBOX mode and a fake of the
 * PayPal API calls (CI never reaches PayPal): an order is created after the
 * PENDING commit, an approval is captured only while the attempt and its
 * hold are payable, and only PAYMENT.CAPTURE.COMPLETED confirms the booking.
 */
describe('PayPal Wallet adapter (isolated database, fake PayPal API)', () => {
  let t: TestApp;
  let env: ApiEnv;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let alice: CustomerActor;
  const gateway = new FakePayPalGateway();
  const clientSecret = syntheticPayPalClientSecret();
  const clientId = syntheticPayPalClientId();
  const webhookId = syntheticPayPalWebhookId();

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({
      DATABASE_URL: database.url,
      // PayPal alone, with the default 15-minute hold.
      PAYMENT_PROVIDER: 'DISABLED',
      PAYMENT_PAYPAL_MODE: 'SANDBOX',
      PAYMENT_PAYPAL_CLIENT_ID: clientId,
      PAYMENT_PAYPAL_CLIENT_SECRET: clientSecret,
      PAYMENT_PAYPAL_WEBHOOK_ID: webhookId,
    });
    t = await startTestApp(env, [], { paypalGateway: gateway });
    countryId = await syntheticCountry(t.app);
    alice = await customerActor(t.app);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    gateway.onCreate = null;
    gateway.onCapture = null;
    gateway.failNext = null;
    gateway.verification = 'SUCCESS';
  });

  const prisma = () => db(t.app);
  const fixture = () => bookableFixture(t.app, { countryId, amount: () => UNIT });
  const hold = async () => {
    const f = await fixture();
    const response = await bookingApi(alice).post('/bookings', holdBody(f, 1, 2, ['1A', '1B']));
    expect(response.status).toBe(201);
    return response.body.reference as string;
  };
  /** A PayPal attempt started through the API: quote, then payment. */
  const start = async (country = 'FR') => {
    const reference = await hold();
    const quoted = await paymentApi(alice).quote(reference, {
      payerCountry: country,
      paymentMethod: 'PAYPAL',
    });
    expect(quoted.status).toBe(201);
    const created = await paymentApi(alice).create(reference, {
      key: idempotencyKey(),
      body: { quoteId: quoted.body.id, paymentMethod: 'PAYPAL' },
    });
    expect(created.status).toBe(201);
    const payment = await prisma().payment.findUniqueOrThrow({
      where: { reference: created.body.payment.reference },
    });
    return { reference, quote: quoted.body, created, payment, orderId: payment.providerPaymentId! };
  };
  const send = (
    raw: string,
    options: { headers?: Record<string, string>; contentType?: string } = {},
  ) =>
    request(t.app.getHttpServer())
      .post(PAYPAL_WEBHOOK)
      .set('Content-Type', options.contentType ?? 'application/json')
      .set(options.headers ?? paypalTransmissionHeaders())
      .send(raw);
  const reload = (id: string) =>
    prisma().payment.findUniqueOrThrow({ where: { id }, include: { booking: true, events: true } });
  const captureRequests = (paymentId: string) =>
    prisma().auditEvent.count({
      where: { resourceType: 'payment', resourceId: paymentId, action: PAYMENT_CAPTURE_REQUESTED },
    });
  const openTransactions = async () => {
    const [open] = await prisma().$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS "count" FROM pg_stat_activity
      WHERE datname = current_database() AND state LIKE 'idle in transaction%'`;
    return Number(open!.count);
  };

  /** A PayPal attempt written under every guard, for a hold that ends in seconds. */
  const expiringAttempt = async () => {
    const f = await fixture();
    const booking = await shortHold(t.app, f, alice.id, 1, 2, ['2A'], 3_000);
    const quote = await insertIdentityQuote(prisma(), booking.id);
    const orderId = orderIdFor(`late-${booking.reference}`);
    const payment = await prisma().payment.create({
      data: {
        reference: `ETP-${booking.reference.slice(4)}`,
        bookingId: booking.id,
        customerIdentityId: alice.id,
        quoteId: quote.id,
        provider: 'PAYPAL',
        amountMinor: BigInt(UNIT),
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
      },
    });
    await prisma().payment.update({
      where: { id: payment.id },
      data: { providerPaymentId: orderId },
    });
    gateway.orders.set(orderId, { id: orderId, capturedWith: null });
    return { booking, payment, orderId };
  };

  describe('routing and payment options', () => {
    it('offers PayPal in France and Spain only', async () => {
      const reference = await hold();
      for (const country of ['FR', 'ES']) {
        const options = await paymentApi(alice).options(reference, country);
        const paypal = (options.body.methods as Array<{ code: string; available: boolean }>).find(
          (method) => method.code === 'PAYPAL',
        );
        expect(paypal, country).toMatchObject({ available: true });
      }
      // Still a catalogue intention in Senegal, never collected there.
      const senegal = await paymentApi(alice).options(reference, 'SN');
      expect(
        (senegal.body.methods as Array<{ code: string; available: boolean }>).find(
          (method) => method.code === 'PAYPAL',
        ),
      ).toMatchObject({ available: false });
      for (const country of ['MA', 'MR']) {
        const options = await paymentApi(alice).options(reference, country);
        expect((options.body.methods as Array<{ code: string }>).map((m) => m.code)).not.toContain(
          'PAYPAL',
        );
      }
      const quoted = await paymentApi(alice).quote(reference, {
        payerCountry: 'SN',
        paymentMethod: 'PAYPAL',
      });
      expect(quoted.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    });
  });

  describe('Create Order', () => {
    it('commits PENDING first, then creates the exact EUR order outside any transaction', async () => {
      const seen: Array<{ status: string | undefined; open: number }> = [];
      gateway.onCreate = async () => {
        const [row] = await prisma().payment.findMany({
          where: { provider: 'PAYPAL', providerPaymentId: null },
          orderBy: { id: 'desc' },
          take: 1,
        });
        seen.push({ status: row?.status, open: await openTransactions() });
      };
      const calls = gateway.createCalls.length;
      const { payment, created, orderId } = await start('ES');
      expect(seen).toEqual([{ status: 'PENDING', open: 0 }]);
      const call = gateway.createCalls[calls]!;
      expect(call.requestId).toBe(payment.reference);
      expect(call.body.purchaseUnits).toEqual([
        expect.objectContaining({
          amount: { currencyCode: 'EUR', value: '249.00' },
          customId: payment.reference,
        }),
      ]);
      expect(orderId).toBe(orderIdFor(payment.reference));
      expect(created.body.checkout).toEqual({
        provider: 'PAYPAL',
        testMode: true,
        redirectUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
      });
      expect(payment).toMatchObject({ status: 'PENDING', amountMinor: BigInt(TOTAL) });
      expect(JSON.stringify(created.body)).not.toContain(clientSecret);
      expect(JSON.stringify(created.body)).not.toContain(clientId);
    });

    it('refuses a forged order id or amount from the client', async () => {
      const reference = await hold();
      const quoted = await paymentApi(alice).quote(reference, {
        payerCountry: 'FR',
        paymentMethod: 'PAYPAL',
      });
      for (const extra of [
        { orderId: 'FORGED1234567' },
        { providerPaymentId: 'X' },
        { amountMinor: 1 },
      ]) {
        const response = await paymentApi(alice).create(reference, {
          body: { quoteId: quoted.body.id, paymentMethod: 'PAYPAL', ...extra },
        });
        expect(response.status, JSON.stringify(extra)).toBe(400);
      }
      expect(await prisma().payment.count({ where: { booking: { reference } } })).toBe(0);
    });
  });

  describe('CHECKOUT.ORDER.APPROVED', () => {
    it('is verified by PayPal, captures outside any transaction, and confirms nothing', async () => {
      const { payment, orderId, reference } = await start();
      const open: number[] = [];
      gateway.onCapture = async () => {
        open.push(await openTransactions());
      };
      const verifies = gateway.verifyCalls.length;
      const response = await send(orderApprovedEvent({ orderId }));
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true, outcome: 'CAPTURE_REQUESTED' });
      // Verified with our webhook ID, the event posted back unchanged.
      expect(gateway.verifyCalls).toHaveLength(verifies + 1);
      expect(JSON.parse(gateway.verifyCalls.at(-1)!)).toMatchObject({ webhook_id: webhookId });
      expect(gateway.captureCalls.at(-1)).toEqual({
        orderId,
        requestId: `${payment.reference}-CAPTURE`,
      });
      expect(open).toEqual([0]);
      // An approval is not a payment.
      const after = await reload(payment.id);
      expect(after.status).toBe('PENDING');
      expect(after.booking.confirmedAt).toBeNull();
      expect(after.events).toEqual([]);
      expect((await bookingApi(alice).get(`/bookings/${reference}`)).body.status).toBe('HELD');
      expect(await captureRequests(payment.id)).toBe(1);
    });

    it('redelivered, asks for the very same capture: never a second debit', async () => {
      const { payment, orderId } = await start();
      const raw = orderApprovedEvent({ orderId });
      expect((await send(raw)).body.outcome).toBe('CAPTURE_REQUESTED');
      expect((await send(raw)).body.outcome).toBe('CAPTURE_REQUESTED');
      expect((await send(orderApprovedEvent({ orderId }))).body.outcome).toBe('CAPTURE_REQUESTED');
      const calls = gateway.captureCalls.filter((call) => call.orderId === orderId);
      expect(calls).toHaveLength(3);
      expect(new Set(calls.map((call) => call.requestId))).toEqual(
        new Set([`${payment.reference}-CAPTURE`]),
      );
      expect(gateway.captures.get(orderId)).toBe(1);
    });

    it('is not captured after the hold expired', async () => {
      const { payment, orderId, booking } = await expiringAttempt();
      await waitUntilExpired(t.app, booking.id);
      const response = await send(
        orderApprovedEvent({ orderId, amount: { currency_code: 'EUR', value: '124.50' } }),
      );
      expect(response.body).toEqual({
        received: true,
        outcome: 'CAPTURE_REFUSED',
        code: 'BOOKING_EXPIRED',
      });
      expect(gateway.captureCalls.filter((call) => call.orderId === orderId)).toEqual([]);
      expect((await reload(payment.id)).status).toBe('PENDING');
    });

    it('is not captured after a local cancellation (LOCAL_CANCEL_PREVENTS_CAPTURE)', async () => {
      const { payment, orderId } = await start();
      const cancelled = await paymentApi(alice).cancel(payment.reference);
      expect(cancelled.status).toBe(200);
      const response = await send(orderApprovedEvent({ orderId }));
      expect(response.body).toMatchObject({
        outcome: 'CAPTURE_REFUSED',
        code: 'PAYMENT_NOT_PENDING',
      });
      expect(gateway.captureCalls.filter((call) => call.orderId === orderId)).toEqual([]);
      expect((await reload(payment.id)).status).toBe('CANCELLED');
    });

    it('once a capture is requested, the attempt can no longer be cancelled', async () => {
      const { payment, orderId } = await start();
      await send(orderApprovedEvent({ orderId }));
      const refused = await paymentApi(alice).cancel(payment.reference);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('PAYMENT_PROVIDER_COMPLETING');
      expect((await reload(payment.id)).status).toBe('PENDING');
    });

    it('is not captured for another amount or currency, nor for an order that is not ours', async () => {
      const { payment, orderId } = await start();
      expect(
        (
          await send(
            orderApprovedEvent({ orderId, amount: { currency_code: 'EUR', value: '1.00' } }),
          )
        ).body,
      ).toMatchObject({ outcome: 'CAPTURE_REFUSED', code: 'AMOUNT_MISMATCH' });
      expect(
        (
          await send(
            orderApprovedEvent({ orderId, amount: { currency_code: 'USD', value: '249.00' } }),
          )
        ).body,
      ).toMatchObject({ outcome: 'CAPTURE_REFUSED', code: 'CURRENCY_MISMATCH' });
      // Not ours: acknowledged (PayPal would otherwise redeliver it for 3 days).
      const foreign = await send(orderApprovedEvent({ orderId: 'FOREIGNORDER00001' }));
      expect(foreign.status).toBe(200);
      expect(foreign.body).toMatchObject({ outcome: 'CAPTURE_REFUSED', code: 'PAYMENT_NOT_FOUND' });
      expect(gateway.captureCalls.filter((call) => call.orderId === orderId)).toEqual([]);
      expect(await captureRequests(payment.id)).toBe(0);
    });

    it('keeps the attempt PENDING when the capture outcome is unknown (503, redelivered)', async () => {
      const { payment, orderId } = await start();
      gateway.onCapture = () => {
        gateway.failNext = new Error('socket timeout');
        return Promise.resolve();
      };
      const response = await send(orderApprovedEvent({ orderId }));
      expect(response.status).toBe(503);
      expect((await reload(payment.id)).status).toBe('PENDING');
      gateway.onCapture = null;
      // PayPal redelivers the approval: the same capture is asked again.
      expect((await send(orderApprovedEvent({ orderId }))).body.outcome).toBe('CAPTURE_REQUESTED');
      expect(gateway.captures.get(orderId)).toBe(1);
    });
  });

  describe('capture events', () => {
    const approvedAndCaptured = async () => {
      const started = await start();
      await send(orderApprovedEvent({ orderId: started.orderId }));
      return started;
    };

    it('PAYMENT.CAPTURE.PENDING waits: nothing changes', async () => {
      const { payment, orderId, reference } = await approvedAndCaptured();
      const response = await send(captureEvent({ type: 'PAYMENT.CAPTURE.PENDING', orderId }));
      expect(response.body).toEqual({ received: true, outcome: 'IGNORED' });
      const after = await reload(payment.id);
      expect(after.status).toBe('PENDING');
      expect(after.events).toEqual([]);
      expect((await bookingApi(alice).get(`/bookings/${reference}`)).body.status).toBe('HELD');
    });

    it('PAYMENT.CAPTURE.COMPLETED confirms once; redelivery acknowledged; other payload refused', async () => {
      const { payment, orderId, reference } = await approvedAndCaptured();
      const raw = captureEvent({ type: 'PAYMENT.CAPTURE.COMPLETED', orderId });
      const response = await send(raw);
      expect(response.body).toEqual({ received: true, outcome: 'PAYMENT_SUCCEEDED' });
      const after = await reload(payment.id);
      expect(after.status).toBe('SUCCEEDED');
      expect(after.booking.confirmedAt).not.toBeNull();
      expect(after.events.map((event) => event.payloadHash)).toEqual([
        createHash('sha256').update(raw).digest('hex'),
      ]);
      expect((await bookingApi(alice).get(`/bookings/${reference}`)).body.status).toBe('CONFIRMED');
      expect((await send(raw)).body.outcome).toBe('DUPLICATE');
      const sameId = captureEvent({
        type: 'PAYMENT.CAPTURE.DENIED',
        orderId,
        eventId: (JSON.parse(raw) as { id: string }).id,
      });
      const conflict = await send(sameId);
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('PAYMENT_WEBHOOK_REPLAY');
      expect(
        await prisma().auditEvent.count({
          where: { action: 'BOOKING_CONFIRMED', resourceId: payment.bookingId },
        }),
      ).toBe(1);
      // A later approval redelivery captures nothing: the attempt is no longer PENDING.
      const captures = gateway.captureCalls.length;
      expect((await send(orderApprovedEvent({ orderId }))).body).toMatchObject({
        outcome: 'CAPTURE_REFUSED',
        code: 'PAYMENT_NOT_PENDING',
      });
      expect(gateway.captureCalls).toHaveLength(captures);
    });

    it.each(['PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED'] as const)(
      '%s fails the attempt',
      async (type) => {
        const { payment, orderId } = await approvedAndCaptured();
        expect((await send(captureEvent({ type, orderId }))).body.outcome).toBe('PAYMENT_FAILED');
        expect(await reload(payment.id)).toMatchObject({
          status: 'FAILED',
          failureCode: 'DECLINED',
        });
      },
    );

    it('CHECKOUT.PAYMENT-APPROVAL.REVERSED fails the attempt before any capture', async () => {
      const { payment, orderId, reference } = await start();
      const response = await send(approvalReversedEvent({ orderId }));
      expect(response.body.outcome).toBe('PAYMENT_FAILED');
      expect(await reload(payment.id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'CHECKOUT_EXPIRED',
      });
      expect((await bookingApi(alice).get(`/bookings/${reference}`)).body.status).toBe('HELD');
    });

    it.each([
      ['amount', { value: '248.99' }, 'AMOUNT_MISMATCH'],
      ['currency', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
    ] as const)('records and refuses a capture of another %s', async (_label, overrides, code) => {
      const { payment, orderId } = await approvedAndCaptured();
      const response = await send(
        captureEvent({ type: 'PAYMENT.CAPTURE.COMPLETED', orderId, ...overrides }),
      );
      expect(response.body).toMatchObject({ outcome: 'REJECTED', code: 'PAYMENT_WEBHOOK_INVALID' });
      const after = await reload(payment.id);
      expect(after.status).toBe('PENDING');
      expect(after.booking.confirmedAt).toBeNull();
      expect(after.events.map((event) => event.rejectionCode)).toEqual([code]);
    });

    it('never confirms a capture completed after the hold expired (fail closed)', async () => {
      const { payment, orderId, booking } = await expiringAttempt();
      // A capture still PENDING at PayPal while the hold runs out: nothing yet.
      expect(
        (await send(captureEvent({ type: 'PAYMENT.CAPTURE.PENDING', orderId, value: '124.50' })))
          .body.outcome,
      ).toBe('IGNORED');
      expect((await reload(payment.id)).status).toBe('PENDING');
      await waitUntilExpired(t.app, booking.id);
      const late = await send(
        captureEvent({ type: 'PAYMENT.CAPTURE.COMPLETED', orderId, value: '124.50' }),
      );
      expect(late.body).toMatchObject({ outcome: 'REJECTED', code: 'PAYMENT_BOOKING_EXPIRED' });
      const after = await reload(payment.id);
      expect(after).toMatchObject({ status: 'FAILED', failureCode: 'BOOKING_EXPIRED' });
      expect(after.booking.confirmedAt).toBeNull();
      // Money was captured: the recorded success is the refund evidence.
      expect(after.events.map((event) => event.type)).toEqual(['PAYMENT_SUCCEEDED']);
    });
  });

  describe('returns from PayPal', () => {
    it('confirm nothing: only the capture event can', async () => {
      const { payment, reference } = await start();
      for (const path of [
        '/compte?paiement=retour',
        '/compte?paiement=abandon',
        '/v1/payments/paypal/return',
      ]) {
        expect((await request(t.app.getHttpServer()).get(path)).status).toBe(404);
      }
      expect((await reload(payment.id)).status).toBe('PENDING');
      expect((await bookingApi(alice).get(`/bookings/${reference}`)).body.status).toBe('HELD');
    });
  });

  describe('webhook authentication', () => {
    it.each([
      [
        'no transmission signature',
        { headers: paypalTransmissionHeaders({ 'PAYPAL-TRANSMISSION-SIG': '' }) },
        401,
      ],
      ['another content type', { contentType: 'text/plain' }, 415],
    ] as const)(
      'refuses an event with %s, before asking PayPal',
      async (_label, options, status) => {
        const { orderId } = await start();
        const verifies = gateway.verifyCalls.length;
        const response = await send(orderApprovedEvent({ orderId }), options);
        expect(response.status).toBe(status);
        expect(gateway.verifyCalls).toHaveLength(verifies);
      },
    );

    it('refuses an event PayPal does not verify, and fails closed when it cannot verify', async () => {
      const { payment, orderId } = await start();
      gateway.verification = 'FAILURE';
      expect(
        (await send(captureEvent({ type: 'PAYMENT.CAPTURE.COMPLETED', orderId }))).status,
      ).toBe(401);
      gateway.verification = 'SUCCESS';
      gateway.failNext = new Error('verification timeout');
      expect(
        (await send(captureEvent({ type: 'PAYMENT.CAPTURE.COMPLETED', orderId }))).status,
      ).toBe(503);
      const after = await reload(payment.id);
      expect(after.status).toBe('PENDING');
      expect(after.events).toEqual([]);
    });

    it('refuses an oversized payload', async () => {
      const { orderId } = await start();
      const raw = orderApprovedEvent({ orderId }).replace(
        '"summary"',
        `"padding":"${'x'.repeat(33 * 1024)}","summary"`,
      );
      expect((await send(raw)).status).toBe(413);
    });
  });

  describe('data protection', () => {
    it('stores no PayPal account data or raw event, and never exposes a credential', async () => {
      const { payment, orderId, reference } = await start();
      await send(orderApprovedEvent({ orderId }));
      await send(captureEvent({ type: 'PAYMENT.CAPTURE.COMPLETED', orderId }));
      const stored = JSON.stringify(
        await prisma().payment.findUniqueOrThrow({
          where: { id: payment.id },
          include: { events: true },
        }),
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
      expect(stored).not.toMatch(
        /CHECKOUT\.ORDER|PAYMENT\.CAPTURE|seller_receivable|purchase_units/,
      );
      const responses = JSON.stringify([
        (await paymentApi(alice).list(reference)).body,
        (await bookingApi(alice).get(`/bookings/${reference}`)).body,
      ]);
      for (const secret of [clientSecret, clientId, webhookId, orderId]) {
        expect(responses).not.toContain(secret);
      }
      const logs = t.logs.raw.join('\n');
      for (const secret of [clientSecret, clientId]) expect(logs).not.toContain(secret);
      expect(logs).not.toContain('CHECKOUT.ORDER.APPROVED');
    });
  });
});

describe('PayPal disabled (default)', () => {
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

  it('has no PayPal webhook route', async () => {
    const response = await request(t.app.getHttpServer())
      .post(PAYPAL_WEBHOOK)
      .set('Content-Type', 'application/json')
      .set(paypalTransmissionHeaders())
      .send(orderApprovedEvent({ orderId: 'DISABLED000000001' }));
    expect(response.status).toBe(404);
  });
});
