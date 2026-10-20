import type { ApiEnv } from '@euroteranga/config';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type PaymentProvider } from '../../../src/payments/providers/payment-provider.js';
import { PaymentCapabilityRegistry } from '../../../src/payments/payment-capability.registry.js';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  syntheticCountry,
  type BookableFixture,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import {
  idempotencyKey,
  paymentApi,
  providerPaymentIdOf,
  sandboxEvent,
  sendWebhook,
  shortHold,
} from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * Real races on PostgreSQL. Lock hierarchy: trip -> payment -> booking ->
 * seats -> seat locks; a deadlock or an unexpected error would surface as a
 * 500, which no scenario accepts.
 */
describe('payment concurrency (isolated database)', () => {
  let t: TestApp;
  let env: ApiEnv;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let alice: CustomerActor;
  let bob: CustomerActor;
  let admin: StaffActor;
  let gate: ReturnType<typeof createDatabaseClient>;
  let provider: PaymentProvider;
  const ROUNDS = 4;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    provider = t.app.get(PaymentCapabilityRegistry).provider('SANDBOX')!;
    countryId = await syntheticCountry(t.app);
    [alice, bob, admin] = await Promise.all([
      customerActor(t.app),
      customerActor(t.app),
      staffActor(t.app, ['SUPER_ADMIN']),
    ]);
    gate = createDatabaseClient({ databaseUrl: database.url });
  });

  afterAll(async () => {
    await gate.$disconnect();
    await t.app.close();
    await database.drop();
  });

  afterEach(() => vi.restoreAllMocks());

  const fixture = () => bookableFixture(t.app, { countryId, amount: () => 5_000 });
  const statuses = (responses: Array<{ status: number }>) =>
    responses.map((response) => response.status).sort();

  /** Both operations started together (free race: any winner, invariants only). */
  const together = <A, B>(a: () => PromiseLike<A>, b: () => PromiseLike<B>) =>
    Promise.all([Promise.resolve(a()), Promise.resolve(b())]);

  /** Sessions waiting on a heavyweight lock in the test database. */
  async function lockWaiters(): Promise<number> {
    const [row] = await gate.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS "count" FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    return Number(row!.count);
  }

  /**
   * A forced-order race: a separate transaction holds a row lock, the two
   * operations queue behind it in the given order (both in flight at once),
   * then the lock is released. PostgreSQL grants a row lock to its waiters in
   * arrival order, so each side is made to win deterministically.
   */
  async function ordered<A, B>(
    lockSql: string,
    first: () => PromiseLike<A>,
    second: () => PromiseLike<B>,
  ): Promise<[A, B]> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const blocker = gate.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(lockSql);
        locked();
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await isLocked;
    const waitFor = async (count: number) => {
      for (let attempt = 0; attempt < 400 && (await lockWaiters()) < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await lockWaiters()).toBeGreaterThanOrEqual(count);
    };
    const a = Promise.resolve(first());
    await waitFor(1);
    const b = Promise.resolve(second());
    await waitFor(2);
    release();
    await blocker;
    return Promise.all([a, b]);
  }

  const lockPayment = (reference: string) =>
    `SELECT 1 FROM "payment" WHERE "reference" = '${reference}' FOR UPDATE`;
  const lockBooking = (reference: string) =>
    `SELECT 1 FROM "booking" WHERE "reference" = '${reference}' FOR UPDATE`;
  const lockTrip = (tripId: string) => `SELECT 1 FROM "trip" WHERE "id" = '${tripId}' FOR UPDATE`;

  async function heldWithAttempt(f: BookableFixture, seat = '1A') {
    const hold = await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, [seat]));
    expect(hold.status).toBe(201);
    const attempt = await paymentApi(alice).create(hold.body.reference as string);
    expect(attempt.status).toBe(201);
    const reference = attempt.body.payment.reference as string;
    return {
      bookingReference: hold.body.reference as string,
      reference,
      providerPaymentId: await providerPaymentIdOf(t.app, reference),
    };
  }

  const event = (
    providerPaymentId: string,
    type: 'payment.succeeded' | 'payment.failed' = 'payment.succeeded',
    id?: string,
  ) =>
    sandboxEvent({
      type,
      providerPaymentId,
      amountMinor: 5_000,
      currency: 'EUR',
      ...(id ? { id } : {}),
      ...(type === 'payment.failed' ? { failureReason: 'declined' } : {}),
    });

  const state = async (bookingReference: string) => {
    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: bookingReference },
      include: { payments: { include: { events: true } }, seats: { include: { locks: true } } },
    });
    return booking;
  };

  /** A confirmed booking always has exactly one succeeded attempt, and conversely. */
  async function assertCoherent(bookingReference: string) {
    const booking = await state(bookingReference);
    const succeeded = booking.payments.filter((payment) => payment.status === 'SUCCEEDED');
    expect(succeeded).toHaveLength(booking.confirmedAt ? 1 : 0);
    expect(
      booking.payments.filter((payment) => payment.status === 'PENDING').length,
    ).toBeLessThanOrEqual(1);
    if (booking.cancelledAt) {
      expect(booking.confirmedAt).toBeNull();
      expect(booking.payments.some((payment) => payment.status === 'PENDING')).toBe(false);
    }
    if (booking.confirmedAt) {
      for (const seat of booking.seats) {
        expect(seat.releasedAt).toBeNull();
        expect(seat.locks).toHaveLength(booking.destinationSequence - booking.originSequence);
      }
    }
    return booking;
  }

  it('A. two simultaneous initiations for one booking: one PENDING attempt, one 409', async () => {
    const providerCalls = vi.spyOn(provider, 'createPayment');
    for (let round = 0; round < ROUNDS; round += 1) {
      providerCalls.mockClear();
      const f = await fixture();
      const hold = await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, ['1A']));
      const results = await Promise.all([
        paymentApi(alice).create(hold.body.reference as string),
        paymentApi(alice).create(hold.body.reference as string),
      ]);
      expect(statuses(results)).toEqual([201, 409]);
      expect(results.find((result) => result.status === 409)!.body.code).toBe(
        'PAYMENT_ALREADY_PENDING',
      );
      const booking = await assertCoherent(hold.body.reference as string);
      expect(booking.payments).toHaveLength(1);
      // The request that lost the database reservation never reaches the provider.
      expect(providerCalls).toHaveBeenCalledTimes(1);
      expect(providerCalls.mock.calls[0]![0].paymentReference).toBe(booking.payments[0]!.reference);
    }
  });

  it('B. the same Idempotency-Key sent concurrently: one attempt, returned to all', async () => {
    const providerCalls = vi.spyOn(provider, 'createPayment');
    for (let round = 0; round < ROUNDS; round += 1) {
      providerCalls.mockClear();
      const f = await fixture();
      const hold = await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, ['1B']));
      const key = idempotencyKey();
      const results = await Promise.all(
        [0, 1, 2].map(() => paymentApi(alice).create(hold.body.reference as string, { key })),
      );
      expect(statuses(results)).toEqual([200, 200, 201]);
      const references = new Set(results.map((result) => result.body.payment.reference as string));
      expect(references.size).toBe(1);
      const reference = [...references][0]!;
      expect(providerCalls).toHaveBeenCalledTimes(3);
      expect(providerCalls.mock.calls.map(([request]) => request.paymentReference)).toEqual([
        reference,
        reference,
        reference,
      ]);
      expect((await state(hold.body.reference as string)).payments).toHaveLength(1);
      expect(
        await db(t.app).auditEvent.count({
          where: {
            action: 'PAYMENT_CREATED',
            after: { path: ['reference'], equals: reference },
          },
        }),
      ).toBe(1);
    }
  });

  it('C. the same success event delivered twice at once: one effect, one replay', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture();
      const attempt = await heldWithAttempt(f);
      const raw = event(attempt.providerPaymentId);
      const results = await Promise.all([
        sendWebhook(t.app, env, raw),
        sendWebhook(t.app, env, raw),
      ]);
      expect(statuses(results)).toEqual([200, 409]);
      expect(results.find((result) => result.status === 409)!.body.code).toBe(
        'PAYMENT_WEBHOOK_REPLAY',
      );
      const booking = await assertCoherent(attempt.bookingReference);
      expect(booking.confirmedAt).not.toBeNull();
      expect(booking.payments[0]!.events).toHaveLength(1);
      expect(
        await db(t.app).auditEvent.count({
          where: { action: 'BOOKING_CONFIRMED', resourceId: booking.id },
        }),
      ).toBe(1);
    }
  });

  it('D. two different success events for one attempt: the booking is confirmed once', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture();
      const attempt = await heldWithAttempt(f);
      const results = await Promise.all([
        sendWebhook(t.app, env, event(attempt.providerPaymentId)),
        sendWebhook(t.app, env, event(attempt.providerPaymentId)),
      ]);
      expect(statuses(results)).toEqual([200, 409]);
      expect(results.find((result) => result.status === 409)!.body.code).toBe(
        'PAYMENT_ALREADY_SUCCEEDED',
      );
      const booking = await assertCoherent(attempt.bookingReference);
      const events = booking.payments[0]!.events;
      expect(events.filter((recorded) => recorded.processedAt !== null)).toHaveLength(1);
      expect(
        events.filter((recorded) => recorded.rejectionCode === 'PAYMENT_ALREADY_SUCCEEDED'),
      ).toHaveLength(1);
      expect(
        await db(t.app).auditEvent.count({
          where: { action: 'BOOKING_CONFIRMED', resourceId: booking.id },
        }),
      ).toBe(1);
    }
  });

  it('E. success racing the customer’s booking cancellation: a coherent final state', async () => {
    const check = async (
      bookingReference: string,
      webhook: { status: number; body: { code?: string } },
      cancel: { status: number; body: { code?: string } },
    ) => {
      const booking = await assertCoherent(bookingReference);
      if (booking.confirmedAt) {
        expect([webhook.status, cancel.status, cancel.body.code]).toEqual([
          200,
          409,
          'BOOKING_CONFIRMED',
        ]);
        expect(booking.payments[0]!.status).toBe('SUCCEEDED');
        return 'confirmed';
      }
      expect([cancel.status, webhook.status, webhook.body.code]).toEqual([
        200,
        409,
        'PAYMENT_INVALID_TRANSITION',
      ]);
      expect(booking.cancelledAt).not.toBeNull();
      expect(booking.payments[0]!.status).toBe('CANCELLED');
      return 'cancelled';
    };
    for (let round = 0; round < ROUNDS; round += 1) {
      const attempt = await heldWithAttempt(await fixture());
      const csrf = await alice.csrf();
      const [webhook, cancel] = await together(
        () => sendWebhook(t.app, env, event(attempt.providerPaymentId)),
        () => bookingApi(alice).post(`/bookings/${attempt.bookingReference}/cancel`, {}, { csrf }),
      );
      await check(attempt.bookingReference, webhook, cancel);
    }
    // Both orders, forced through the payment row lock both paths take first.
    const success = await heldWithAttempt(await fixture());
    const successCsrf = await alice.csrf();
    const [won, lost] = await ordered(
      lockPayment(success.reference),
      () => sendWebhook(t.app, env, event(success.providerPaymentId)),
      () =>
        bookingApi(alice).post(
          `/bookings/${success.bookingReference}/cancel`,
          {},
          { csrf: successCsrf },
        ),
    );
    expect(await check(success.bookingReference, won, lost)).toBe('confirmed');
    const cancelled = await heldWithAttempt(await fixture());
    const cancelCsrf = await alice.csrf();
    const [cancelFirst, webhookSecond] = await ordered(
      lockPayment(cancelled.reference),
      () =>
        bookingApi(alice).post(
          `/bookings/${cancelled.bookingReference}/cancel`,
          {},
          { csrf: cancelCsrf },
        ),
      () => sendWebhook(t.app, env, event(cancelled.providerPaymentId)),
    );
    expect(await check(cancelled.bookingReference, webhookSecond, cancelFirst)).toBe('cancelled');
  });

  it('F. success racing the expiry cleanup: a confirmed booking never loses its seat', async () => {
    for (const offsetMs of [-400, -150, 0, 150, 400]) {
      const f = await fixture();
      const ttl = 2_500;
      const short = await shortHold(t.app, f, alice.id, 1, 3, ['2A'], ttl);
      const attempt = await paymentApi(alice).create(short.reference);
      expect(attempt.status).toBe(201);
      const providerPaymentId = await providerPaymentIdOf(
        t.app,
        attempt.body.payment.reference as string,
      );
      const booking = await db(t.app).booking.findUniqueOrThrow({ where: { id: short.id } });
      const wait = booking.holdExpiresAt.getTime() + offsetMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      // Hold creations on the trip run the expired-hold cleanup.
      const [webhook, sameSeat, otherSeat] = await Promise.all([
        sendWebhook(t.app, env, event(providerPaymentId)),
        bookingApi(bob).post('/bookings', holdBody(f, 1, 3, ['2A'])),
        bookingApi(bob).post('/bookings', holdBody(f, 1, 3, ['2B'])),
      ]);
      expect(otherSeat.status).toBe(201);
      const after = await assertCoherent(short.reference);
      if (after.confirmedAt) {
        expect(webhook.status).toBe(200);
        expect(sameSeat.status).toBe(409);
        expect(sameSeat.body.code).toBe('BOOKING_SEAT_UNAVAILABLE');
      } else {
        expect(webhook.status).toBe(409);
        expect(webhook.body.code).toBe('PAYMENT_BOOKING_EXPIRED');
        expect(after.payments[0]).toMatchObject({
          status: 'FAILED',
          failureCode: 'BOOKING_EXPIRED',
        });
        expect([201, 409]).toContain(sameSeat.status);
      }
      // Never two occupants of the same seat and segment.
      const doubles = await db(t.app).$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS "count" FROM (
          SELECT l."seat_map_cell_id", l."segment_sequence"
          FROM "seat_inventory_lock" l
          JOIN "booking_seat" bs ON bs."id" = l."booking_seat_id"
          JOIN "booking" b ON b."id" = bs."booking_id"
          WHERE l."trip_id" = ${f.tripId}::uuid AND b."cancelled_at" IS NULL
            AND (b."confirmed_at" IS NOT NULL OR b."hold_expires_at" > now())
          GROUP BY 1, 2 HAVING count(*) > 1
        ) d`;
      expect(doubles[0]!.count).toBe(0n);
    }
  });

  it('G. success racing the trip cancellation: never a cancelled trip with a confirmed booking', async () => {
    const check = async (
      f: BookableFixture,
      bookingReference: string,
      webhook: { status: number },
      cancel: { status: number; body: { code?: string } },
    ) => {
      const trip = await db(t.app).trip.findUniqueOrThrow({ where: { id: f.tripId } });
      const booking = await assertCoherent(bookingReference);
      if (trip.status === 'CANCELLED') {
        expect(cancel.status).toBe(200);
        expect(booking.confirmedAt).toBeNull();
        expect(booking.cancelledAt).not.toBeNull();
        expect(webhook.status).toBe(409);
        expect(booking.payments[0]!.status).not.toBe('SUCCEEDED');
        return 'trip cancelled';
      }
      expect([cancel.status, cancel.body.code]).toEqual([409, 'TRIP_HAS_CONFIRMED_BOOKINGS']);
      expect(webhook.status).toBe(200);
      expect(booking.confirmedAt).not.toBeNull();
      return 'booking confirmed';
    };
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture();
      const attempt = await heldWithAttempt(f);
      const csrf = await admin.csrf();
      const [webhook, cancel] = await together(
        () => sendWebhook(t.app, env, event(attempt.providerPaymentId)),
        () =>
          adminApi(admin).post(`/trips/${f.tripId}/cancel`, { reason: 'Course de test' }, { csrf }),
      );
      await check(f, attempt.bookingReference, webhook, cancel);
    }
    // Forced orders: trip cancellation locks the trip, then the PENDING payment.
    const confirmedTrip = await fixture();
    const confirmed = await heldWithAttempt(confirmedTrip);
    const confirmedCsrf = await admin.csrf();
    const [webhookFirst, refused] = await ordered(
      lockPayment(confirmed.reference),
      () => sendWebhook(t.app, env, event(confirmed.providerPaymentId)),
      () =>
        adminApi(admin).post(
          `/trips/${confirmedTrip.tripId}/cancel`,
          { reason: 'Course de test' },
          { csrf: confirmedCsrf },
        ),
    );
    expect(await check(confirmedTrip, confirmed.bookingReference, webhookFirst, refused)).toBe(
      'booking confirmed',
    );
    const cancelledTrip = await fixture();
    const cancelled = await heldWithAttempt(cancelledTrip);
    const cancelledCsrf = await admin.csrf();
    const [tripFirst, webhookSecond] = await ordered(
      lockPayment(cancelled.reference),
      () =>
        adminApi(admin).post(
          `/trips/${cancelledTrip.tripId}/cancel`,
          { reason: 'Course de test' },
          { csrf: cancelledCsrf },
        ),
      () => sendWebhook(t.app, env, event(cancelled.providerPaymentId)),
    );
    expect(await check(cancelledTrip, cancelled.bookingReference, webhookSecond, tripFirst)).toBe(
      'trip cancelled',
    );
  });

  it('H. failure and success events at once: a single terminal transition', async () => {
    const check = async (
      bookingReference: string,
      success: { status: number; body: { code?: string } },
      failure: { status: number; body: { code?: string } },
    ) => {
      expect(statuses([success, failure])).toEqual([200, 409]);
      const loser = success.status === 409 ? success : failure;
      expect(loser.body.code).toBe('PAYMENT_INVALID_TRANSITION');
      const booking = await assertCoherent(bookingReference);
      const payment = booking.payments[0]!;
      expect(payment.events.filter((recorded) => recorded.processedAt !== null)).toHaveLength(1);
      if (success.status === 200) {
        expect(payment.status).toBe('SUCCEEDED');
        expect(booking.confirmedAt).not.toBeNull();
        return 'succeeded';
      }
      expect(payment).toMatchObject({ status: 'FAILED', failureCode: 'DECLINED' });
      expect(booking.confirmedAt).toBeNull();
      expect(booking.cancelledAt).toBeNull();
      return 'failed';
    };
    for (let round = 0; round < ROUNDS; round += 1) {
      const attempt = await heldWithAttempt(await fixture());
      const [success, failure] = await together(
        () => sendWebhook(t.app, env, event(attempt.providerPaymentId, 'payment.succeeded')),
        () => sendWebhook(t.app, env, event(attempt.providerPaymentId, 'payment.failed')),
      );
      await check(attempt.bookingReference, success, failure);
    }
    const first = await heldWithAttempt(await fixture());
    const [successFirst, failureSecond] = await ordered(
      lockPayment(first.reference),
      () => sendWebhook(t.app, env, event(first.providerPaymentId, 'payment.succeeded')),
      () => sendWebhook(t.app, env, event(first.providerPaymentId, 'payment.failed')),
    );
    expect(await check(first.bookingReference, successFirst, failureSecond)).toBe('succeeded');
    const second = await heldWithAttempt(await fixture());
    const [failureFirst, successSecond] = await ordered(
      lockPayment(second.reference),
      () => sendWebhook(t.app, env, event(second.providerPaymentId, 'payment.failed')),
      () => sendWebhook(t.app, env, event(second.providerPaymentId, 'payment.succeeded')),
    );
    expect(await check(second.bookingReference, successSecond, failureFirst)).toBe('failed');
  });

  it('I. initiation racing the trip cancellation: no PENDING attempt survives a cancelled trip', async () => {
    const providerCalls = vi.spyOn(provider, 'createPayment');
    const check = async (
      bookingReference: string,
      attempt: { status: number; body: { code?: string } },
      cancel: { status: number },
    ) => {
      expect(cancel.status).toBe(200);
      expect([201, 409]).toContain(attempt.status);
      if (attempt.status === 409) {
        expect(['PAYMENT_BOOKING_NOT_PAYABLE', 'PAYMENT_INVALID_TRANSITION']).toContain(
          attempt.body.code,
        );
      }
      const booking = await assertCoherent(bookingReference);
      expect(booking.cancelledAt).not.toBeNull();
      expect(booking.payments.every((payment) => payment.status === 'CANCELLED')).toBe(true);
      // A reserved attempt can lose Phase C to the cancellation and answer
      // INVALID_TRANSITION; its durable CANCELLED row still proves Phase A won.
      return booking.payments.length === 1 ? 'attempt first' : 'trip first';
    };
    const start = async () => {
      const f = await fixture();
      const hold = await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, ['1A']));
      const [customerCsrf, staffCsrf] = await Promise.all([alice.csrf(), admin.csrf()]);
      // The quote is ready: the race is the initiation itself.
      const body = await paymentApi(alice).paymentBody(hold.body.reference as string);
      return {
        f,
        reference: hold.body.reference as string,
        pay: () =>
          paymentApi(alice).create(hold.body.reference as string, { csrf: customerCsrf, body }),
        cancel: () =>
          adminApi(admin).post(
            `/trips/${f.tripId}/cancel`,
            { reason: 'Course initiation' },
            { csrf: staffCsrf },
          ),
      };
    };
    for (let round = 0; round < ROUNDS; round += 1) {
      const race = await start();
      const [attempt, cancel] = await together(race.pay, race.cancel);
      await check(race.reference, attempt, cancel);
    }
    // Forced orders through the trip row: initiation takes it FOR SHARE first.
    const payFirst = await start();
    providerCalls.mockClear();
    const [attempt, cancel] = await ordered(
      lockTrip(payFirst.f.tripId),
      payFirst.pay,
      payFirst.cancel,
    );
    expect(await check(payFirst.reference, attempt, cancel)).toBe('attempt first');
    expect(providerCalls).toHaveBeenCalledTimes(1);
    const tripFirst = await start();
    providerCalls.mockClear();
    const [cancelFirst, attemptSecond] = await ordered(
      lockTrip(tripFirst.f.tripId),
      tripFirst.cancel,
      tripFirst.pay,
    );
    expect(await check(tripFirst.reference, attemptSecond, cancelFirst)).toBe('trip first');
    expect(providerCalls).not.toHaveBeenCalled();
  });

  it('J. initiation racing the booking cancellation: no PENDING attempt on a cancelled booking', async () => {
    const providerCalls = vi.spyOn(provider, 'createPayment');
    const check = async (
      reference: string,
      attempt: { status: number; body: { code?: string } },
      cancel: { status: number; body: { code?: string } },
    ) => {
      expect([201, 409]).toContain(attempt.status);
      expect([200, 409]).toContain(cancel.status);
      if (cancel.status === 409) expect(cancel.body.code).toBe('BOOKING_CANCEL_CONFLICT');
      if (attempt.status === 409) {
        expect(['PAYMENT_BOOKING_NOT_PAYABLE', 'PAYMENT_INVALID_TRANSITION']).toContain(
          attempt.body.code,
        );
      }
      const booking = await assertCoherent(reference);
      if (cancel.status === 200) {
        expect(booking.payments.every((payment) => payment.status === 'CANCELLED')).toBe(true);
        return booking.payments.length === 1 ? 'attempt then cancellation' : 'cancellation first';
      }
      // The attempt committed between the two locks: nothing was cancelled.
      expect(booking.cancelledAt).toBeNull();
      expect(booking.payments.map((payment) => payment.status)).toEqual(['PENDING']);
      return 'conflict';
    };
    const start = async () => {
      const f = await fixture();
      const hold = await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, ['1B']));
      const reference = hold.body.reference as string;
      const [paymentCsrf, cancelCsrf] = await Promise.all([alice.csrf(), alice.csrf()]);
      // The quote is ready: the race is the initiation itself.
      const body = await paymentApi(alice).paymentBody(reference);
      return {
        reference,
        pay: () => paymentApi(alice).create(reference, { csrf: paymentCsrf, body }),
        cancel: () =>
          bookingApi(alice).post(`/bookings/${reference}/cancel`, {}, { csrf: cancelCsrf }),
      };
    };
    for (let round = 0; round < ROUNDS; round += 1) {
      const race = await start();
      const [attempt, cancel] = await together(race.pay, race.cancel);
      await check(race.reference, attempt, cancel);
    }
    // Forced orders through the booking row both paths lock. Initiation first:
    // its attempt commits after the cancellation locked the (no) PENDING
    // payments, so the cancellation reports a conflict instead of inverting
    // the payment -> booking lock order.
    const payFirst = await start();
    providerCalls.mockClear();
    const [attempt, cancel] = await ordered(
      lockBooking(payFirst.reference),
      payFirst.pay,
      payFirst.cancel,
    );
    expect(await check(payFirst.reference, attempt, cancel)).toBe('conflict');
    expect(providerCalls).toHaveBeenCalledTimes(1);
    const cancelFirst = await start();
    providerCalls.mockClear();
    const [cancelled, refused] = await ordered(
      lockBooking(cancelFirst.reference),
      cancelFirst.cancel,
      cancelFirst.pay,
    );
    expect(await check(cancelFirst.reference, refused, cancelled)).toBe('cancellation first');
    expect(providerCalls).not.toHaveBeenCalled();
  });
});
