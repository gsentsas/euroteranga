import type { ApiEnv } from '@euroteranga/config';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type PaymentProvider,
  type ProviderPaymentRequest,
} from '../../../src/payments/providers/payment-provider.js';
import { PaymentCapabilityRegistry } from '../../../src/payments/payment-capability.registry.js';
import { adminApi, isolatedDatabase, staffActor } from '../../support/admin-helpers.js';
import { db, withoutRequestId } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  expiredHold,
  holdBody,
  syntheticCountry,
  type BookableFixture,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import {
  idempotencyKey,
  paymentApi,
  settle,
  shortHold,
  waitUntilExpired,
} from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const REFERENCE = /^ETP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

/**
 * CUSTOMER payment attempts through the SANDBOX provider: the amount comes
 * from the booking only, a result only from a signed provider event, and a
 * CONFIRMED booking keeps its seats for good. Own database (one test
 * installs a temporary failing trigger on audit_event).
 */
describe('customer payments and booking confirmation (isolated database)', () => {
  let t: TestApp;
  let env: ApiEnv;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let alice: CustomerActor;
  let bob: CustomerActor;
  let provider: PaymentProvider;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url, BOOKING_HOLD_TTL_SECONDS: '900' });
    t = await startTestApp(env);
    provider = t.app.get(PaymentCapabilityRegistry).provider('SANDBOX')!;
    countryId = await syntheticCountry(t.app);
    [alice, bob] = await Promise.all([customerActor(t.app), customerActor(t.app)]);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  afterEach(() => vi.restoreAllMocks());

  const fixture = (options = {}) => bookableFixture(t.app, { countryId, ...options });
  const hold = async (
    actor: CustomerActor,
    f: BookableFixture,
    origin: number,
    destination: number,
    seats: string[],
  ) => {
    const response = await bookingApi(actor).post(
      '/bookings',
      holdBody(f, origin, destination, seats),
    );
    expect(response.status).toBe(201);
    return response.body as { reference: string; totalAmountMinor: number };
  };
  const auditOf = (action: string, resourceId: string) =>
    db(t.app).auditEvent.findFirstOrThrow({ where: { action, resourceId } });

  describe('authentication and authorization', () => {
    it('requires a CUSTOMER session and a CSRF token; STAFF sessions are refused', async () => {
      const f = await fixture();
      const booking = await hold(alice, f, 1, 3, ['1A']);
      const server = t.app.getHttpServer();
      const path = `/v1/booking/bookings/${booking.reference}/payments`;
      const anonymous = await request(server)
        .post(path)
        .set('Origin', 'http://localhost:3002')
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(anonymous.status).toBe(401);
      expect((await request(server).get(path)).status).toBe(401);
      expect((await paymentApi(alice).create(booking.reference, { csrf: null })).status).toBe(403);
      const staff = await staffActor(t.app, ['SUPER_ADMIN']);
      const withStaffCookie = await request(server)
        .post(path)
        .set('Origin', 'http://localhost:3002')
        .set('Content-Type', 'application/json')
        .set('Cookie', staff.cookie)
        .send('{}');
      expect(withStaffCookie.status).toBe(401);
      expect(await db(t.app).payment.count({ where: { booking: { tripId: f.tripId } } })).toBe(0);
    });

    it('hides other customers’ bookings and payments behind the same 404', async () => {
      const f = await fixture();
      const booking = await hold(alice, f, 1, 3, ['1A']);
      const created = await paymentApi(alice).create(booking.reference);
      expect(created.status).toBe(201);
      const paymentReference = created.body.payment.reference as string;

      const unknownBooking = await paymentApi(bob).create('ETB-0000000000AA');
      const foreignBooking = await paymentApi(bob).create(booking.reference);
      expect(foreignBooking.status).toBe(404);
      expect(withoutRequestId(foreignBooking.body)).toEqual(withoutRequestId(unknownBooking.body));
      expect(withoutRequestId(foreignBooking.body)).toEqual({
        code: 'BOOKING_NOT_FOUND',
        message: 'Réservation introuvable.',
      });
      const foreignList = await paymentApi(bob).list(booking.reference);
      expect(foreignList.status).toBe(404);
      expect(withoutRequestId(foreignList.body)).toEqual(
        withoutRequestId((await paymentApi(bob).list('ETB-0000000000AA')).body),
      );
      const foreignCancel = await paymentApi(bob).cancel(paymentReference);
      const unknownCancel = await paymentApi(bob).cancel('ETP-0000000000AA');
      expect(foreignCancel.status).toBe(404);
      expect(withoutRequestId(foreignCancel.body)).toEqual(withoutRequestId(unknownCancel.body));
      expect(foreignCancel.body.code).toBe('PAYMENT_NOT_FOUND');
      const stored = await db(t.app).payment.findUniqueOrThrow({
        where: { reference: paymentReference },
      });
      expect(stored.status).toBe('PENDING');
    });
  });

  describe('initiation', () => {
    it('commits the reserved attempt and audit before calling the provider', async () => {
      const f = await fixture();
      const booking = await hold(alice, f, 1, 3, ['2A']);
      const key = idempotencyKey();
      const original = provider.createPayment.bind(provider);
      let entered!: (request: ProviderPaymentRequest) => void;
      let release!: () => void;
      const providerEntered = new Promise<ProviderPaymentRequest>((resolve) => (entered = resolve));
      const providerReleased = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(provider, 'createPayment').mockImplementation(async (request) => {
        entered(request);
        await providerReleased;
        return original(request);
      });

      const responsePromise = paymentApi(alice).create(booking.reference, { key });
      const request = await providerEntered;
      try {
        const reserved = await db(t.app).payment.findUniqueOrThrow({
          where: { reference: request.paymentReference },
        });
        expect(reserved).toMatchObject({
          status: 'PENDING',
          providerPaymentId: null,
          idempotencyKey: key,
        });
        expect(
          await db(t.app).auditEvent.count({
            where: { action: 'PAYMENT_CREATED', resourceId: reserved.id },
          }),
        ).toBe(1);
        // The reservation transaction is committed and holds no row lock
        // while the instrumented provider call is paused.
        const locked = await db(t.app).$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "payment"
          WHERE "id" = ${reserved.id}::uuid
          FOR UPDATE NOWAIT`;
        expect(locked).toEqual([{ id: reserved.id }]);
      } finally {
        release();
      }
      const response = await responsePromise;
      expect(response.status).toBe(201);
      expect(response.body.payment.reference).toBe(request.paymentReference);
      expect(
        (
          await db(t.app).payment.findUniqueOrThrow({
            where: { reference: request.paymentReference },
          })
        ).providerPaymentId,
      ).toMatch(/^sbx_[A-Za-z0-9_-]{24}$/);
    });

    it('derives an exact PENDING attempt from the booking and audits it', async () => {
      const f = await fixture({ amount: () => 12_345 });
      const booking = await hold(alice, f, 1, 3, ['1A', '2B']);
      const response = await paymentApi(alice).create(booking.reference);
      expect(response.status).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        payment: {
          reference: expect.stringMatching(REFERENCE),
          status: 'PENDING',
          amountMinor: 24_690,
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
          // PAY-HUB-1: the method and the amount presented to the payer.
          paymentMethod: 'CARD_CB',
          payerCountry: 'FR',
          presentment: { amountMinor: 24_690, currencyCode: 'EUR', currencyMinorUnit: 2 },
          createdAt: expect.any(String),
          succeededAt: null,
          failedAt: null,
          cancelledAt: null,
        },
        checkout: { provider: 'SANDBOX', testMode: true, redirectUrl: null },
      });
      // Never the booking reference, nothing internal or provider-side.
      const body = JSON.stringify(response.body);
      expect(body).not.toContain(booking.reference.slice(4));
      expect(body).not.toMatch(/sbx_|providerPaymentId|idempotency|customerIdentityId|"id"/);
      const stored = await db(t.app).payment.findUniqueOrThrow({
        where: { reference: response.body.payment.reference },
      });
      expect(stored).toMatchObject({
        status: 'PENDING',
        provider: 'SANDBOX',
        amountMinor: 24_690n,
        customerIdentityId: alice.id,
        idempotencyKey: null,
      });
      expect(stored.providerPaymentId).toMatch(/^sbx_[A-Za-z0-9_-]{24}$/);
      const audit = await auditOf('PAYMENT_CREATED', stored.id);
      expect(audit).toMatchObject({ actorIdentityId: alice.id, actorRealm: 'CUSTOMER' });
      expect(audit.after).toMatchObject({
        reference: stored.reference,
        status: 'PENDING',
        provider: 'SANDBOX',
        bookingReference: booking.reference,
        seatCount: 2,
        amountMinor: 24_690,
        currencyCode: 'EUR',
      });
      expect(JSON.stringify(audit)).not.toMatch(/sbx_|@example\.test/);
      // The customer's views show the attempt.
      const list = await paymentApi(alice).list(booking.reference);
      expect(list.body.items).toEqual([response.body.payment]);
      const detail = await bookingApi(alice).get(`/bookings/${booking.reference}`);
      expect(detail.body).toMatchObject({
        status: 'HELD',
        confirmedAt: null,
        payment: response.body.payment,
      });
    });

    it('accepts no amount, currency, provider or identity from the client', async () => {
      const f = await fixture();
      const booking = await hold(alice, f, 1, 2, ['1A']);
      for (const body of [
        { amountMinor: 1 },
        { currencyCode: 'XOF' },
        { provider: 'SANDBOX' },
        { unitAmountMinor: 1 },
        { customerIdentityId: bob.id },
      ]) {
        const response = await paymentApi(alice).create(booking.reference, { body });
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect(await db(t.app).payment.count({ where: { booking: { tripId: f.tripId } } })).toBe(0);
    });

    it('is idempotent per customer key and allows one PENDING attempt per booking', async () => {
      const f = await fixture();
      const booking = await hold(alice, f, 1, 3, ['1A']);
      const key = idempotencyKey();
      const first = await paymentApi(alice).create(booking.reference, { key });
      expect(first.status).toBe(201);
      const replay = await paymentApi(alice).create(booking.reference, { key });
      expect(replay.status).toBe(200);
      expect(replay.body.payment).toEqual(first.body.payment);
      const other = await paymentApi(alice).create(booking.reference, { key: idempotencyKey() });
      expect(other.status).toBe(409);
      expect(other.body.code).toBe('PAYMENT_ALREADY_PENDING');
      const keyless = await paymentApi(alice).create(booking.reference);
      expect(keyless.body.code).toBe('PAYMENT_ALREADY_PENDING');
      expect(
        await db(t.app).payment.count({ where: { booking: { reference: booking.reference } } }),
      ).toBe(1);
      expect(
        await db(t.app).auditEvent.count({
          where: {
            action: 'PAYMENT_CREATED',
            after: { path: ['bookingReference'], equals: booking.reference },
          },
        }),
      ).toBe(1);

      // The same key for another booking is refused, not silently reused.
      const second = await hold(alice, f, 1, 2, ['2A']);
      const reused = await paymentApi(alice).create(second.reference, { key });
      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe('PAYMENT_IDEMPOTENCY_KEY_REUSED');
      // Another customer's identical key is unrelated.
      const bobBooking = await hold(bob, f, 3, 5, ['1A']);
      expect((await paymentApi(bob).create(bobBooking.reference, { key })).status).toBe(201);
      // Malformed keys are refused.
      for (const bad of ['short', 'x'.repeat(65), 'with space in the key!!', 'é'.repeat(20)]) {
        const response = await paymentApi(alice).create(second.reference, { key: bad });
        expect(response.status, bad).toBe(400);
        expect(response.body.code).toBe('PAYMENT_IDEMPOTENCY_KEY_INVALID');
      }
    });

    it('keeps a provider failure reserved and recovers it with the same key and reference', async () => {
      const f = await fixture();
      const booking = await hold(alice, f, 1, 3, ['2B']);
      const key = idempotencyKey();
      const original = provider.createPayment.bind(provider);
      const calls = vi
        .spyOn(provider, 'createPayment')
        .mockRejectedValueOnce(new Error('simulated lost provider response'))
        .mockImplementation(original);

      const failed = await paymentApi(alice).create(booking.reference, { key });
      expect(failed.status).toBe(500);
      const reserved = await db(t.app).payment.findFirstOrThrow({
        where: { booking: { reference: booking.reference } },
      });
      expect(reserved).toMatchObject({
        status: 'PENDING',
        providerPaymentId: null,
        idempotencyKey: key,
      });
      expect(
        await db(t.app).auditEvent.count({
          where: { action: 'PAYMENT_CREATED', resourceId: reserved.id },
        }),
      ).toBe(1);

      const replay = await paymentApi(alice).create(booking.reference, { key });
      expect(replay.status).toBe(200);
      expect(replay.body.payment.reference).toBe(reserved.reference);
      expect(
        await db(t.app).payment.count({ where: { booking: { reference: booking.reference } } }),
      ).toBe(1);
      expect(
        (await db(t.app).payment.findUniqueOrThrow({ where: { id: reserved.id } }))
          .providerPaymentId,
      ).toMatch(/^sbx_[A-Za-z0-9_-]{24}$/);
      expect(calls).toHaveBeenCalledTimes(2);
      expect(calls.mock.calls.map(([request]) => request.paymentReference)).toEqual([
        reserved.reference,
        reserved.reference,
      ]);
    });

    it('refuses expired, cancelled and confirmed bookings', async () => {
      const calls = vi.spyOn(provider, 'createPayment');
      const f = await fixture();
      const expired = await expiredHold(t.app, f, alice.id, 1, 2, ['1A']);
      calls.mockClear();
      const late = await paymentApi(alice).create(expired.reference);
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('PAYMENT_BOOKING_EXPIRED');
      expect(calls).not.toHaveBeenCalled();

      const cancelled = await hold(alice, f, 2, 3, ['1A']);
      expect((await bookingApi(alice).post(`/bookings/${cancelled.reference}/cancel`)).status).toBe(
        200,
      );
      calls.mockClear();
      const afterCancel = await paymentApi(alice).create(cancelled.reference);
      expect(afterCancel.status).toBe(409);
      expect(afterCancel.body.code).toBe('PAYMENT_BOOKING_NOT_PAYABLE');
      expect(calls).not.toHaveBeenCalled();

      const confirmed = await hold(alice, f, 3, 4, ['1A']);
      const paid = await paymentApi(alice).create(confirmed.reference);
      expect((await settle(t.app, env, paid.body.payment)).status).toBe(200);
      calls.mockClear();
      const again = await paymentApi(alice).create(confirmed.reference);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('PAYMENT_BOOKING_CONFIRMED');
      expect(calls).not.toHaveBeenCalled();
      expect(
        await db(t.app).payment.count({
          where: { booking: { reference: { in: [expired.reference, cancelled.reference] } } },
        }),
      ).toBe(0);
    });

    it('never calls the provider for a cancelled or departed trip', async () => {
      const staff = await staffActor(t.app, ['SUPER_ADMIN']);
      const cancelledTrip = await fixture();
      const cancelledBooking = await hold(alice, cancelledTrip, 1, 3, ['1B']);
      expect(
        (
          await adminApi(staff).post(`/trips/${cancelledTrip.tripId}/cancel`, {
            reason: 'Voyage annulé avant paiement',
          })
        ).status,
      ).toBe(200);
      const calls = vi.spyOn(provider, 'createPayment');
      const onCancelled = await paymentApi(alice).create(cancelledBooking.reference);
      expect(onCancelled.status).toBe(409);
      expect(onCancelled.body.code).toBe('PAYMENT_BOOKING_NOT_PAYABLE');
      expect(calls).not.toHaveBeenCalled();

      // A hold cannot legally outlast its trip. Use a short, guarded hold,
      // then wait until both the hold and its trip are in the past.
      const departingTrip = await fixture({ departureInMs: 12_000 });
      const departedBooking = await shortHold(t.app, departingTrip, alice.id, 1, 3, ['2A'], 3_000);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await db(t.app).$queryRaw<Array<{ departed: boolean }>>`
          SELECT "planned_departure_at" <= now() AS "departed"
          FROM "trip" WHERE "id" = ${departingTrip.tripId}::uuid`;
        if (row?.departed) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const [departure] = await db(t.app).$queryRaw<Array<{ departed: boolean }>>`
        SELECT "planned_departure_at" <= now() AS "departed"
        FROM "trip" WHERE "id" = ${departingTrip.tripId}::uuid`;
      expect(departure?.departed).toBe(true);
      calls.mockClear();
      const afterDeparture = await paymentApi(alice).create(departedBooking.reference);
      expect(afterDeparture.status).toBe(409);
      expect(afterDeparture.body.code).toBe('PAYMENT_BOOKING_EXPIRED');
      expect(calls).not.toHaveBeenCalled();
    }, 35_000);

    it('lets the owner cancel a PENDING attempt; the booking stays HELD and payable', async () => {
      const f = await fixture();
      const booking = await hold(alice, f, 1, 3, ['2A']);
      const attempt = await paymentApi(alice).create(booking.reference);
      const cancelled = await paymentApi(alice).cancel(attempt.body.payment.reference);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({
        reference: attempt.body.payment.reference,
        status: 'CANCELLED',
        cancelledAt: expect.any(String),
      });
      const again = await paymentApi(alice).cancel(attempt.body.payment.reference);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('PAYMENT_INVALID_TRANSITION');
      const stored = await db(t.app).payment.findUniqueOrThrow({
        where: { reference: attempt.body.payment.reference },
      });
      expect((await auditOf('PAYMENT_CANCELLED', stored.id)).metadata).toMatchObject({
        cancelledBy: 'CUSTOMER',
        bookingReference: booking.reference,
      });
      expect((await bookingApi(alice).get(`/bookings/${booking.reference}`)).body.status).toBe(
        'HELD',
      );
      // A new attempt is possible; history keeps both.
      expect((await paymentApi(alice).create(booking.reference)).status).toBe(201);
      const list = await paymentApi(alice).list(booking.reference);
      expect(list.body.items.map((item: { status: string }) => item.status)).toEqual([
        'PENDING',
        'CANCELLED',
      ]);
    });
  });

  describe('provider results', () => {
    it('confirms the booking atomically on a signed success event', async () => {
      const f = await fixture({ currencyCode: 'XOF', currencyMinorUnit: 0, amount: () => 15_000 });
      const booking = await hold(alice, f, 1, 3, ['1A', '1B', '2A']);
      const attempt = await paymentApi(alice).create(booking.reference);
      expect(attempt.body.payment).toMatchObject({
        amountMinor: 45_000,
        currencyCode: 'XOF',
        currencyMinorUnit: 0,
      });
      const result = await settle(t.app, env, attempt.body.payment);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ received: true, outcome: 'PAYMENT_SUCCEEDED' });

      const detail = await bookingApi(alice).get(`/bookings/${booking.reference}`);
      expect(detail.body).toMatchObject({
        status: 'CONFIRMED',
        confirmedAt: expect.any(String),
        totalAmountMinor: 45_000,
        payment: {
          reference: attempt.body.payment.reference,
          status: 'SUCCEEDED',
          amountMinor: 45_000,
          currencyCode: 'XOF',
          succeededAt: detail.body.confirmedAt,
        },
      });
      const payment = await db(t.app).payment.findUniqueOrThrow({
        where: { reference: attempt.body.payment.reference },
        include: { events: true },
      });
      expect(payment.events).toHaveLength(1);
      expect(payment.events[0]).toMatchObject({
        type: 'PAYMENT_SUCCEEDED',
        provider: 'SANDBOX',
        rejectionCode: null,
        payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(payment.events[0]!.processedAt).toEqual(payment.succeededAt);
      const succeeded = await auditOf('PAYMENT_SUCCEEDED', payment.id);
      const confirmed = await auditOf('BOOKING_CONFIRMED', payment.bookingId);
      for (const audit of [succeeded, confirmed]) {
        // System actor (the provider), with the provider event id and no secret.
        expect(audit).toMatchObject({ actorIdentityId: null, actorRealm: null });
        expect(audit.metadata).toMatchObject({
          provider: 'SANDBOX',
          providerEventId: payment.events[0]!.providerEventId,
          paymentReference: payment.reference,
          bookingReference: booking.reference,
        });
        expect(JSON.stringify(audit)).not.toMatch(/v1=|signature|secret|sbx_/i);
      }
      // A confirmed booking cannot be cancelled by its owner (no refund yet).
      const cancel = await bookingApi(alice).post(`/bookings/${booking.reference}/cancel`);
      expect(cancel.status).toBe(409);
      expect(cancel.body.code).toBe('BOOKING_CONFIRMED');
    });

    it('records a failure with a normalized code; the hold stays payable', async () => {
      const f = await fixture();
      const booking = await hold(alice, f, 1, 2, ['2B']);
      const first = await paymentApi(alice).create(booking.reference);
      const declined = await settle(t.app, env, first.body.payment, 'payment.failed', {
        failureReason: 'declined',
      });
      expect(declined.body).toEqual({ received: true, outcome: 'PAYMENT_FAILED' });
      const second = await paymentApi(alice).create(booking.reference);
      expect(second.status).toBe(201);
      // Unknown provider text is never stored nor returned.
      await settle(t.app, env, second.body.payment, 'payment.failed', {
        failureReason: 'Raw provider message <script>',
      });
      const stored = await db(t.app).payment.findMany({
        where: { booking: { reference: booking.reference } },
        orderBy: { id: 'asc' },
      });
      expect(stored.map((payment) => [payment.status, payment.failureCode])).toEqual([
        ['FAILED', 'DECLINED'],
        ['FAILED', 'UNKNOWN'],
      ]);
      const list = await paymentApi(alice).list(booking.reference);
      expect(JSON.stringify(list.body)).not.toMatch(/Raw provider|script|DECLINED|failureCode/);
      expect(list.body.items[0]).toMatchObject({ status: 'FAILED', failedAt: expect.any(String) });
      expect((await auditOf('PAYMENT_FAILED', stored[0]!.id)).after).toMatchObject({
        status: 'FAILED',
        failureCode: 'DECLINED',
      });
      expect((await bookingApi(alice).get(`/bookings/${booking.reference}`)).body.status).toBe(
        'HELD',
      );
      expect((await paymentApi(alice).create(booking.reference)).status).toBe(201);
    });

    it('refuses a replayed event without any second effect', async () => {
      const f = await fixture();
      const booking = await hold(alice, f, 1, 3, ['1B']);
      const attempt = await paymentApi(alice).create(booking.reference);
      const id = 'evt_replay_once_only';
      expect(
        (await settle(t.app, env, attempt.body.payment, 'payment.succeeded', { id })).status,
      ).toBe(200);
      const replay = await settle(t.app, env, attempt.body.payment, 'payment.succeeded', { id });
      expect(replay.status).toBe(409);
      expect(replay.body.code).toBe('PAYMENT_WEBHOOK_REPLAY');
      const payment = await db(t.app).payment.findUniqueOrThrow({
        where: { reference: attempt.body.payment.reference },
        include: { events: true },
      });
      expect(payment.events).toHaveLength(1);
      expect(
        await db(t.app).auditEvent.count({
          where: { action: 'BOOKING_CONFIRMED', resourceId: payment.bookingId },
        }),
      ).toBe(1);
    });

    it('fails a success that arrives after the hold expired (no confirmation)', async () => {
      const f = await fixture();
      const expiring = await shortHold(t.app, f, alice.id, 1, 3, ['2A'], 3_000);
      const attempt = await paymentApi(alice).create(expiring.reference);
      expect(attempt.status).toBe(201);
      await waitUntilExpired(t.app, expiring.id);
      const late = await settle(t.app, env, attempt.body.payment);
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('PAYMENT_BOOKING_EXPIRED');
      const payment = await db(t.app).payment.findUniqueOrThrow({
        where: { reference: attempt.body.payment.reference },
        include: { events: true },
      });
      expect(payment).toMatchObject({ status: 'FAILED', failureCode: 'BOOKING_EXPIRED' });
      expect(payment.events[0]!.processedAt).not.toBeNull();
      const booking = await bookingApi(alice).get(`/bookings/${expiring.reference}`);
      expect(booking.body).toMatchObject({ status: 'EXPIRED', confirmedAt: null });
      // Its seat is free again for an overlapping journey.
      expect((await bookingApi(bob).post('/bookings', holdBody(f, 2, 4, ['2A']))).status).toBe(201);
    });
  });

  describe('confirmed inventory', () => {
    it('keeps the seats of a confirmed booking after holdExpiresAt and through cleanups', async () => {
      const f = await fixture();
      const short = await shortHold(t.app, f, alice.id, 2, 4, ['1A'], 4_000);
      const attempt = await paymentApi(alice).create(short.reference);
      expect((await settle(t.app, env, attempt.body.payment)).status).toBe(200);
      await waitUntilExpired(t.app, short.id);

      // Derived status ignores the passed hold expiry once confirmed.
      const detail = await bookingApi(alice).get(`/bookings/${short.reference}`);
      expect(detail.body.status).toBe('CONFIRMED');
      // A hold creation on the trip runs the expired cleanup: nothing released.
      expect((await bookingApi(bob).post('/bookings', holdBody(f, 1, 2, ['1A']))).status).toBe(201);
      const seats = await db(t.app).bookingSeat.findMany({
        where: { bookingId: short.id },
        include: { locks: true },
      });
      expect(seats[0]!.releasedAt).toBeNull();
      expect(seats[0]!.locks.map((lock) => lock.segmentSequence).sort()).toEqual([2, 3]);
      // Overlapping journeys are refused; the adjacent [4, 5) is free.
      const overlap = await bookingApi(bob).post('/bookings', holdBody(f, 3, 5, ['1A']));
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe('BOOKING_SEAT_UNAVAILABLE');
      // Read the segment [3, 4) that only the confirmed booking occupies (bob's
      // hold [1, 2) does not touch it): availability and search count the seat.
      const availability = await request(t.app.getHttpServer()).get(
        `/v1/booking/trips/${f.tripId}/availability?originRouteWaypointId=${f.wp[3]}&destinationRouteWaypointId=${f.wp[4]}`,
      );
      expect(availability.body.availableSeatCount).toBe(3);
      const cell = availability.body.cells.find(
        (candidate: { seatLabel: string }) => candidate.seatLabel === '1A',
      );
      expect(cell.available).toBe(false);
      const search = await request(t.app.getHttpServer()).get(
        `/v1/booking/trips?originStopId=${f.stopIds[2]}&destinationStopId=${f.stopIds[3]}`,
      );
      const journey = search.body.items.find(
        (item: { tripId: string }) => item.tripId === f.tripId,
      );
      expect(journey).toMatchObject({ seatCount: 4, availableSeatCount: 3 });
      expect((await bookingApi(bob).post('/bookings', holdBody(f, 4, 5, ['1A']))).status).toBe(201);
      // Neither the owner nor STAFF can cancel it; the trip cannot be cancelled.
      expect((await bookingApi(alice).post(`/bookings/${short.reference}/cancel`)).body.code).toBe(
        'BOOKING_CONFIRMED',
      );
      const staff = adminApi(await staffActor(t.app, ['SUPER_ADMIN']));
      const staffCancel = await staff.post(`/bookings/${short.id}/cancel`, {
        reason: 'Essai STAFF',
      });
      expect(staffCancel.status).toBe(409);
      expect(staffCancel.body.code).toBe('BOOKING_CONFIRMED');
      const tripCancel = await staff.post(`/trips/${f.tripId}/cancel`, { reason: 'Essai voyage' });
      expect(tripCancel.status).toBe(409);
      expect(tripCancel.body.code).toBe('TRIP_HAS_CONFIRMED_BOOKINGS');
      // The refused trip cancellation changed nothing (HELD holds included).
      expect((await db(t.app).trip.findUniqueOrThrow({ where: { id: f.tripId } })).status).toBe(
        'SCHEDULED',
      );
      expect(
        await db(t.app).booking.count({ where: { tripId: f.tripId, cancelledAt: { not: null } } }),
      ).toBe(0);
    });
  });

  describe('cancellations with a PENDING attempt', () => {
    it('cancels the attempt with its hold; a later success cannot confirm', async () => {
      const f = await fixture();
      const booking = await hold(alice, f, 1, 3, ['1B']);
      const attempt = await paymentApi(alice).create(booking.reference);
      const cancelled = await bookingApi(alice).post(`/bookings/${booking.reference}/cancel`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({
        status: 'CANCELLED',
        payment: { reference: attempt.body.payment.reference, status: 'CANCELLED' },
      });
      const late = await settle(t.app, env, attempt.body.payment);
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('PAYMENT_INVALID_TRANSITION');
      const payment = await db(t.app).payment.findUniqueOrThrow({
        where: { reference: attempt.body.payment.reference },
        include: { events: true },
      });
      expect(payment.status).toBe('CANCELLED');
      expect(payment.events).toMatchObject([
        { processedAt: null, rejectionCode: 'PAYMENT_NOT_PENDING' },
      ]);
      expect((await bookingApi(alice).get(`/bookings/${booking.reference}`)).body.status).toBe(
        'CANCELLED',
      );
    });

    it('lets a trip with only HELD bookings be cancelled, with their attempts', async () => {
      const f = await fixture();
      const booking = await hold(alice, f, 1, 3, ['2B']);
      const attempt = await paymentApi(alice).create(booking.reference);
      const staff = await staffActor(t.app, ['SUPER_ADMIN']);
      const cancelled = await adminApi(staff).post(`/trips/${f.tripId}/cancel`, {
        reason: 'Panne',
      });
      expect(cancelled.status).toBe(200);
      const payment = await db(t.app).payment.findUniqueOrThrow({
        where: { reference: attempt.body.payment.reference },
      });
      expect(payment.status).toBe('CANCELLED');
      expect(await auditOf('PAYMENT_CANCELLED', payment.id)).toMatchObject({
        actorIdentityId: staff.id,
        metadata: expect.objectContaining({ cancelledBy: 'TRIP', reason: 'Voyage annulé : Panne' }),
      });
      expect((await auditOf('TRIP_CANCELLED', f.tripId)).metadata).toMatchObject({
        cancelledBookingCount: 1,
        cancelledPaymentCount: 1,
      });
      expect((await bookingApi(alice).get(`/bookings/${booking.reference}`)).body.status).toBe(
        'CANCELLED',
      );
    });
  });

  describe('exact money', () => {
    it('keeps totals beyond 32 bits exact (BIGINT amount, safe JSON number)', async () => {
      const f = await fixture({ amount: () => 2_000_000_000 });
      const booking = await hold(alice, f, 1, 2, ['1A', '1B', '2A']);
      const attempt = await paymentApi(alice).create(booking.reference);
      expect(attempt.body.payment.amountMinor).toBe(6_000_000_000);
      expect(Number.isSafeInteger(attempt.body.payment.amountMinor)).toBe(true);
      expect(
        (
          await db(t.app).payment.findUniqueOrThrow({
            where: { reference: attempt.body.payment.reference },
          })
        ).amountMinor,
      ).toBe(6_000_000_000n);
      expect((await settle(t.app, env, attempt.body.payment)).status).toBe(200);
      expect(
        (await bookingApi(alice).get(`/bookings/${booking.reference}`)).body.payment.amountMinor,
      ).toBe(6_000_000_000);
    });
  });

  describe('audit atomicity', () => {
    it('rolls back creation, success and cancellation when their audit insert fails', async () => {
      const f = await fixture();
      const toCreate = await hold(alice, f, 1, 2, ['1A']);
      const toSettle = await hold(alice, f, 2, 3, ['1A']);
      const toCancel = await hold(alice, f, 3, 4, ['1A']);
      const settling = await paymentApi(alice).create(toSettle.reference);
      const cancelling = await paymentApi(alice).create(toCancel.reference);
      await db(t.app).$executeRawUnsafe(`
        CREATE FUNCTION test_fail_payment_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action IN ('PAYMENT_CREATED', 'BOOKING_CONFIRMED', 'PAYMENT_CANCELLED') THEN
            RAISE EXCEPTION 'simulated audit failure';
          END IF;
          RETURN NEW;
        END; $$`);
      await db(t.app).$executeRawUnsafe(
        'CREATE TRIGGER test_fail_payment_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_payment_audit()',
      );
      try {
        expect((await paymentApi(alice).create(toCreate.reference)).status).toBe(500);
        expect(
          await db(t.app).payment.count({ where: { booking: { reference: toCreate.reference } } }),
        ).toBe(0);

        // BOOKING_CONFIRMED is the last write: everything before it rolls back.
        expect((await settle(t.app, env, settling.body.payment)).status).toBe(500);
        const pending = await db(t.app).payment.findUniqueOrThrow({
          where: { reference: settling.body.payment.reference },
          include: { events: true },
        });
        expect(pending.status).toBe('PENDING');
        expect(pending.events).toHaveLength(0);
        expect((await bookingApi(alice).get(`/bookings/${toSettle.reference}`)).body.status).toBe(
          'HELD',
        );
        expect(
          await db(t.app).auditEvent.count({
            where: { action: 'PAYMENT_SUCCEEDED', resourceId: pending.id },
          }),
        ).toBe(0);

        expect((await paymentApi(alice).cancel(cancelling.body.payment.reference)).status).toBe(
          500,
        );
        expect(
          (
            await db(t.app).payment.findUniqueOrThrow({
              where: { reference: cancelling.body.payment.reference },
            })
          ).status,
        ).toBe('PENDING');
      } finally {
        await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_payment_audit ON audit_event');
        await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_payment_audit()');
      }
      // The same success event is accepted once the audit works again.
      expect((await settle(t.app, env, settling.body.payment)).status).toBe(200);
      expect((await bookingApi(alice).get(`/bookings/${toSettle.reference}`)).body.status).toBe(
        'CONFIRMED',
      );
    });
  });
});
