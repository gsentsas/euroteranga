import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  expiredHold,
  holdBody,
  syntheticCountry,
  type BookableFixture,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * Real concurrency on PostgreSQL: the unique index on (trip, seat, segment)
 * is the authority against overbooking; locks are taken in a fixed order.
 */
describe('booking concurrency (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let alice: CustomerActor;
  let bob: CustomerActor;
  let admin: StaffActor;
  const ROUNDS = 4;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    countryId = await syntheticCountry(t.app);
    [alice, bob, admin] = await Promise.all([
      customerActor(t.app),
      customerActor(t.app),
      staffActor(t.app, ['SUPER_ADMIN']),
    ]);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const fixture = () => bookableFixture(t.app, { countryId });
  const hold = (actor: CustomerActor, body: unknown) => bookingApi(actor).post('/bookings', body);

  /** No (trip, seat, segment) is held twice by active holds; no orphan lock. */
  async function assertNoOversell(f: BookableFixture) {
    const doubles = await db(t.app).$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS "count" FROM (
        SELECT l."seat_map_cell_id", l."segment_sequence"
        FROM "seat_inventory_lock" l
        JOIN "booking_seat" bs ON bs."id" = l."booking_seat_id"
        JOIN "booking" b ON b."id" = bs."booking_id"
        WHERE l."trip_id" = ${f.tripId}::uuid AND b."cancelled_at" IS NULL AND b."hold_expires_at" > now()
        GROUP BY 1, 2 HAVING count(*) > 1
      ) d`;
    expect(doubles[0]!.count).toBe(0n);
    const orphans = await db(t.app).$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS "count" FROM "seat_inventory_lock" l
      JOIN "booking_seat" bs ON bs."id" = l."booking_seat_id"
      JOIN "booking" b ON b."id" = bs."booking_id"
      WHERE l."trip_id" = ${f.tripId}::uuid AND (b."cancelled_at" IS NOT NULL OR bs."released_at" IS NOT NULL)`;
    expect(orphans[0]!.count).toBe(0n);
  }

  const statuses = (responses: Array<{ status: number }>) =>
    responses.map((response) => response.status).sort();

  it('A. two customers, same seat, same segments: one hold, one 409', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture();
      const results = await Promise.all([
        hold(alice, holdBody(f, 1, 3, ['1A'])),
        hold(bob, holdBody(f, 1, 3, ['1A'])),
      ]);
      expect(statuses(results)).toEqual([201, 409]);
      expect(results.find((response) => response.status === 409)?.body.code).toBe(
        'BOOKING_SEAT_UNAVAILABLE',
      );
      expect(await db(t.app).booking.count({ where: { tripId: f.tripId } })).toBe(1);
      await assertNoOversell(f);
    }
  });

  it('B. same seat on adjacent segments [1,3) and [3,5): both succeed', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture();
      const results = await Promise.all([
        hold(alice, holdBody(f, 1, 3, ['1A'])),
        hold(bob, holdBody(f, 3, 5, ['1A'])),
      ]);
      expect(statuses(results)).toEqual([201, 201]);
      const locks = await db(t.app).seatInventoryLock.findMany({
        where: { tripId: f.tripId, seatMapCellId: f.cells['1A'] },
        orderBy: { segmentSequence: 'asc' },
        select: { segmentSequence: true },
      });
      expect(locks.map((lock) => lock.segmentSequence)).toEqual([1, 2, 3, 4]);
      await assertNoOversell(f);
    }
  });

  it('C. same seat on partially overlapping segments [1,4) and [3,5): one 409', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture();
      const results = await Promise.all([
        hold(alice, holdBody(f, 1, 4, ['1A'])),
        hold(bob, holdBody(f, 3, 5, ['1A'])),
      ]);
      expect(statuses(results)).toEqual([201, 409]);
      await assertNoOversell(f);
    }
  });

  it('D. an expired hold never blocks: new holds race for the seat, exactly one wins', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture();
      const stale = await expiredHold(t.app, f, alice.id, 1, 5, ['1A', '1B']);
      // The stale locks are still physically present until the next mutation.
      expect(await db(t.app).seatInventoryLock.count({ where: { tripId: f.tripId } })).toBe(8);
      const results = await Promise.all([
        hold(alice, holdBody(f, 2, 4, ['1A'])),
        hold(bob, holdBody(f, 1, 3, ['1A', '1B'])),
      ]);
      expect(statuses(results)).toEqual([201, 409]);
      const seats = await db(t.app).bookingSeat.findMany({ where: { bookingId: stale.id } });
      const expiry = (await db(t.app).booking.findUniqueOrThrow({ where: { id: stale.id } }))
        .holdExpiresAt;
      expect(seats.map((seat) => seat.releasedAt?.toISOString())).toEqual([
        expiry.toISOString(),
        expiry.toISOString(),
      ]);
      expect(
        await db(t.app).seatInventoryLock.count({
          where: { bookingSeat: { bookingId: stale.id } },
        }),
      ).toBe(0);
      await assertNoOversell(f);
    }
  });

  it('E. customer cancellation racing a new hold on the same seat: never oversold', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture();
      const first = await hold(alice, holdBody(f, 1, 5, ['1A']));
      const [cancel, next] = await Promise.all([
        bookingApi(alice).post(`/bookings/${first.body.reference}/cancel`, {}),
        hold(bob, holdBody(f, 2, 3, ['1A'])),
      ]);
      expect(cancel.status).toBe(200);
      expect([201, 409]).toContain(next.status);
      await assertNoOversell(f);
      // Whatever the interleaving, the seat is usable once the cancellation committed.
      if (next.status === 409) {
        expect((await hold(bob, holdBody(f, 2, 3, ['1A']))).status).toBe(201);
      }
    }
  });

  it('F. trip cancellation racing a hold: never an active hold on a cancelled trip', async () => {
    for (let round = 0; round < ROUNDS + 2; round += 1) {
      const f = await fixture();
      const [created, cancelled] = await Promise.all([
        hold(alice, holdBody(f, 1, 3, ['1A'])),
        adminApi(admin).post(`/trips/${f.tripId}/cancel`, { reason: 'Course concurrente' }),
      ]);
      expect(cancelled.status).toBe(200);
      expect([201, 404]).toContain(created.status);
      if (created.status === 404) expect(created.body.code).toBe('BOOKING_TRIP_NOT_BOOKABLE');
      const active = await db(t.app).$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS "count" FROM "booking"
        WHERE "trip_id" = ${f.tripId}::uuid AND "cancelled_at" IS NULL AND "hold_expires_at" > now()`;
      expect(active[0]!.count).toBe(0n);
      expect(await db(t.app).seatInventoryLock.count({ where: { tripId: f.tripId } })).toBe(0);
      if (created.status === 201) {
        expect(
          await db(t.app).auditEvent.count({
            where: {
              action: 'BOOKING_CANCELLED_BY_TRIP',
              resourceType: 'booking',
              metadata: { path: ['tripId'], equals: f.tripId },
            },
          }),
        ).toBe(1);
      }
    }
  });

  it('G. two simultaneous cancellations: one applies, the other sees it cancelled', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture();
      const created = await hold(alice, holdBody(f, 1, 3, ['1A', '1B']));
      const booking = await db(t.app).booking.findUniqueOrThrow({
        where: { reference: created.body.reference },
      });
      const results = await Promise.all([
        bookingApi(alice).post(`/bookings/${created.body.reference}/cancel`, {}),
        adminApi(admin).post(`/bookings/${booking.id}/cancel`, { reason: 'Annulation agent' }),
      ]);
      expect(statuses(results)).toEqual([200, 409]);
      expect(results.find((response) => response.status === 409)?.body.code).toBe(
        'BOOKING_CANCELLED',
      );
      expect(
        await db(t.app).auditEvent.count({
          where: { resourceId: booking.id, action: 'BOOKING_CANCELLED' },
        }),
      ).toBe(1);
    }
  });

  it('H. a multi-seat hold with one unavailable seat rolls back entirely; crossed requests never deadlock', async () => {
    const f = await fixture();
    await hold(bob, holdBody(f, 1, 3, ['2A']));
    const before = await db(t.app).bookingSeat.count();
    const refused = await hold(alice, holdBody(f, 1, 3, ['1A', '1B', '2A']));
    expect(refused.status).toBe(409);
    expect(await db(t.app).bookingSeat.count()).toBe(before);
    expect(
      await db(t.app).booking.count({ where: { customerIdentityId: alice.id, tripId: f.tripId } }),
    ).toBe(0);
    expect((await hold(alice, holdBody(f, 1, 3, ['1A', '1B']))).status).toBe(201);

    for (let round = 0; round < ROUNDS; round += 1) {
      const g = await fixture();
      const results = await Promise.all([
        hold(alice, holdBody(g, 1, 4, ['1A', '1B', '2A'])),
        hold(bob, holdBody(g, 2, 5, ['2A', '1B', '2B'])),
      ]);
      expect(statuses(results)).toEqual([201, 409]);
      const winner = results.find((response) => response.status === 201)!;
      expect(winner.body.seatCount).toBe(3);
      expect(await db(t.app).booking.count({ where: { tripId: g.tripId } })).toBe(1);
      await assertNoOversell(g);
    }
  });
});
