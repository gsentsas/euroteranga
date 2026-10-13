import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase, staffActor } from '../../support/admin-helpers.js';
import { db, withoutRequestId } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  expiredHold,
  holdBody,
  syntheticCountry,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const MAX_SEATS = 3;

/**
 * CUSTOMER holds: the booker is the authenticated customer, never a guest;
 * reads and cancellations are scoped to the owner. Own database (one test
 * installs a temporary failing trigger on audit_event).
 */
describe('customer booking holds (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let alice: CustomerActor;
  let bob: CustomerActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(
      integrationEnv({
        DATABASE_URL: database.url,
        BOOKING_MAX_SEATS_PER_HOLD: String(MAX_SEATS),
        BOOKING_HOLD_TTL_SECONDS: '900',
        // The booking app is a CUSTOMER origin, as in .env.example and CI.
        AUTH_CUSTOMER_ORIGINS: 'http://localhost:3002,http://localhost:3001',
      }),
    );
    countryId = await syntheticCountry(t.app);
    [alice, bob] = await Promise.all([customerActor(t.app), customerActor(t.app)]);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const fixture = (options = {}) => bookableFixture(t.app, { countryId, ...options });

  describe('authentication', () => {
    it('requires a CUSTOMER session and a CSRF token; STAFF sessions are refused', async () => {
      const f = await fixture();
      const server = t.app.getHttpServer();
      const anonymous = await request(server)
        .post('/v1/booking/bookings')
        .set('Origin', 'http://localhost:3002')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(holdBody(f, 1, 3, ['1A'])));
      expect(anonymous.status).toBe(401);
      expect((await request(server).get('/v1/booking/bookings')).status).toBe(401);
      expect(
        (await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, ['1A']), { csrf: null }))
          .status,
      ).toBe(403);
      expect(
        (
          await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, ['1A']), {
            csrf: 'v1.9999999999.x.y',
          })
        ).status,
      ).toBe(403);
      const staff = await staffActor(t.app, ['SUPER_ADMIN']);
      // A STAFF session cookie is not a CUSTOMER session.
      const withStaffCookie = await request(server)
        .get('/v1/booking/bookings')
        .set('Origin', 'http://localhost:3002')
        .set('Cookie', staff.cookie);
      expect(withStaffCookie.status).toBe(401);
      // And the OPS origin is not a customer origin.
      const fromOps = await staff.http.get('/v1/booking/bookings', staff.cookie);
      expect(fromOps.status).toBe(403);
      expect(fromOps.body.code).toBe('ORIGIN_NOT_ALLOWED');
      expect(await db(t.app).booking.count({ where: { tripId: f.tripId } })).toBe(0);
    });

    it('accepts the booking app origin and refuses any other origin', async () => {
      const f = await fixture();
      const csrf = await alice.csrf();
      const from = (origin: string) =>
        request(t.app.getHttpServer())
          .post('/v1/booking/bookings')
          .set('Origin', origin)
          .set('Cookie', alice.cookie)
          .set('X-CSRF-Token', csrf)
          .set('Content-Type', 'application/json')
          .send(JSON.stringify(holdBody(f, 1, 2, ['1A'])));
      const foreign = await from('http://localhost:3003');
      expect(foreign.status).toBe(403);
      expect(foreign.body.code).toBe('ORIGIN_NOT_ALLOWED');
      expect((await from('http://localhost:3001')).status).toBe(201);
    });

    it('accepts no price, currency, fare, label or identity from the client', async () => {
      const f = await fixture();
      for (const extra of [
        { unitAmountMinor: 1 },
        { currencyCode: 'EUR' },
        { fareEntryId: f.fareTableVersionId },
        { customerIdentityId: bob.id },
        { email: 'someone@example.test' },
        { seatLabels: ['1A'] },
      ]) {
        const response = await bookingApi(alice).post('/bookings', {
          ...holdBody(f, 1, 3, ['1A']),
          ...extra,
        });
        expect(response.status, JSON.stringify(extra)).toBe(400);
      }
      expect(await db(t.app).booking.count({ where: { tripId: f.tripId } })).toBe(0);
    });
  });

  describe('creation', () => {
    it('creates an audited provisional hold with the exact fare snapshot and segment locks', async () => {
      const f = await fixture();
      const response = await bookingApi(alice).post('/bookings', holdBody(f, 1, 4, ['2B', '1A']));
      expect(response.status).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body;
      expect(body.reference).toMatch(/^ETB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
      expect(body).toMatchObject({
        status: 'HELD',
        trip: { id: f.tripId, reference: f.tripReference },
        origin: { routeWaypointId: f.wp[1], stop: { id: f.stopIds[0] } },
        destination: { routeWaypointId: f.wp[4], stop: { id: f.stopIds[3] } },
        unitAmountMinor: 3000,
        seatCount: 2,
        totalAmountMinor: 6000,
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        cancelledAt: null,
      });
      expect((body.seats as Array<{ seatLabel: string }>).map((seat) => seat.seatLabel)).toEqual([
        '1A',
        '2B',
      ]);
      expect(body).not.toHaveProperty('id');
      expect(body).not.toHaveProperty('customerIdentityId');
      const ttl = new Date(body.holdExpiresAt).getTime() - new Date(body.createdAt).getTime();
      expect(ttl).toBeGreaterThanOrEqual(899_000);
      expect(ttl).toBeLessThanOrEqual(900_000);

      const stored = await db(t.app).booking.findUniqueOrThrow({
        where: { reference: body.reference },
        include: { seats: { include: { locks: true } }, fareEntry: true },
      });
      expect(stored).toMatchObject({
        customerIdentityId: alice.id,
        originSequence: 1,
        destinationSequence: 4,
        unitAmountMinor: stored.fareEntry.amountMinor,
        fareEntry: {
          fareTableVersionId: f.fareTableVersionId,
          originRouteWaypointId: f.wp[1],
          destinationRouteWaypointId: f.wp[4],
        },
      });
      for (const seat of stored.seats) {
        expect(seat.locks.map((lock) => lock.segmentSequence).sort()).toEqual([1, 2, 3]);
      }
      const audit = await db(t.app).auditEvent.findFirstOrThrow({
        where: { resourceId: stored.id, action: 'BOOKING_HELD' },
      });
      expect(audit).toMatchObject({ actorIdentityId: alice.id, actorRealm: 'CUSTOMER' });
      expect(audit.after).toMatchObject({
        reference: body.reference,
        seatLabels: ['1A', '2B'],
        totalAmountMinor: 6000,
      });
      expect(JSON.stringify(audit)).not.toContain(alice.email);
    });

    it('never lets a hold outlast the trip departure', async () => {
      const f = await fixture({ departureInMs: 5 * 60_000 });
      const response = await bookingApi(alice).post('/bookings', holdBody(f, 1, 2, ['1A']));
      expect(response.status).toBe(201);
      const trip = await db(t.app).trip.findUniqueOrThrow({ where: { id: f.tripId } });
      expect(new Date(response.body.holdExpiresAt).toISOString()).toBe(
        trip.plannedDepartureAt!.toISOString(),
      );
    });

    it('refuses non-bookable trips, invalid journeys and invalid seat choices', async () => {
      const f = await fixture({ withCheckpoint: true, unpricedPairs: ['2-4'] });
      const other = await fixture();
      const cases: Array<[string, unknown, number, string]> = [
        [
          'draft',
          holdBody(await fixture({ status: 'DRAFT' }), 1, 3, ['1A']),
          404,
          'BOOKING_TRIP_NOT_BOOKABLE',
        ],
        [
          'departed',
          holdBody(await fixture({ departureInMs: -3_600_000 }), 1, 3, ['1A']),
          422,
          'BOOKING_TRIP_DEPARTED',
        ],
        [
          'no seat map',
          holdBody(await fixture({ withSeatMap: false }), 1, 3, ['1A']),
          422,
          'BOOKING_SEAT_MAP_NOT_CONFIGURED',
        ],
        [
          'no pricing',
          holdBody(await fixture({ withPricing: false }), 1, 3, ['1A']),
          422,
          'BOOKING_PRICING_NOT_CONFIGURED',
        ],
        ['reversed', holdBody(f, 3, 1, ['1A']), 422, 'BOOKING_OD_INVALID'],
        [
          'checkpoint',
          { ...holdBody(f, 1, 3, ['1A']), destinationRouteWaypointId: f.checkpointWaypointId },
          422,
          'BOOKING_OD_INVALID',
        ],
        [
          'other route',
          { ...holdBody(f, 1, 3, ['1A']), originRouteWaypointId: other.wp[1] },
          422,
          'BOOKING_OD_INVALID',
        ],
        ['unpriced pair', holdBody(f, 2, 4, ['1A']), 404, 'BOOKING_FARE_NOT_CONFIGURED'],
        ['aisle', holdBody(f, 1, 3, ['AISLE']), 422, 'BOOKING_SEAT_INVALID'],
        ['driver', holdBody(f, 1, 3, ['DRIVER']), 422, 'BOOKING_SEAT_INVALID'],
        [
          'seat of another seat map',
          { ...holdBody(f, 1, 3, []), seatMapCellIds: [other.cells['1A']] },
          422,
          'BOOKING_SEAT_INVALID',
        ],
        ['duplicate seat', holdBody(f, 1, 3, ['1A', '1A']), 422, 'BOOKING_SEAT_INVALID'],
        [
          'too many seats',
          holdBody(f, 1, 3, ['1A', '1B', '2A', '2B']),
          422,
          'BOOKING_TOO_MANY_SEATS',
        ],
      ];
      for (const [label, body, status, code] of cases) {
        const response = await bookingApi(alice).post('/bookings', body);
        expect(response.status, label).toBe(status);
        expect(response.body.code, label).toBe(code);
        expect(JSON.stringify(response.body), label).not.toMatch(/prisma|postgres|SQL/i);
      }
      expect(
        (
          await bookingApi(alice).post('/bookings', {
            ...holdBody(f, 1, 3, []),
            seatMapCellIds: [],
          })
        ).status,
      ).toBe(400);
      expect(
        await db(t.app).booking.count({
          where: { customerIdentityId: alice.id, tripId: f.tripId },
        }),
      ).toBe(0);
    });

    it('books the trip historical seat map and pricing, not the vehicle or the current fares', async () => {
      const f = await fixture();
      // Another published seat map, configured on the trip's vehicle after scheduling.
      const g = await fixture();
      const vehicle = await db(t.app).vehicle.create({
        data: { code: `VH_BK_${Date.now()}`, manufacturer: 'Constructeur', model: 'Modèle' },
      });
      await db(t.app).vehicle.update({ where: { id: vehicle.id }, data: { status: 'ACTIVE' } });
      await db(t.app).vehicle.update({
        where: { id: vehicle.id },
        data: { seatMapVersionId: f.seatMapVersionId },
      });
      await db(t.app).trip.update({ where: { id: f.tripId }, data: { vehicleId: vehicle.id } });
      await db(t.app).vehicle.update({
        where: { id: vehicle.id },
        data: { seatMapVersionId: g.seatMapVersionId },
      });
      // A new fare version is published: the trip keeps its historical one.
      const current = await db(t.app).fareTableVersion.findUniqueOrThrow({
        where: { id: f.fareTableVersionId },
      });
      const next = await db(t.app).fareTableVersion.create({
        data: { fareTableId: current.fareTableId, routeVersionId: f.routeVersionId, version: 2 },
      });
      await db(t.app).fareEntry.create({
        data: {
          fareTableVersionId: next.id,
          originRouteWaypointId: f.wp[1]!,
          destinationRouteWaypointId: f.wp[3]!,
          amountMinor: 99_999,
        },
      });
      await db(t.app).fareTableVersion.update({
        where: { id: f.fareTableVersionId },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
      await db(t.app).fareTableVersion.update({
        where: { id: next.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });

      const refused = await bookingApi(alice).post('/bookings', {
        ...holdBody(f, 1, 3, []),
        seatMapCellIds: [g.cells['1A']],
      });
      expect(refused.body.code).toBe('BOOKING_SEAT_INVALID');
      const held = await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, ['1A']));
      expect(held.status).toBe(201);
      expect(held.body.unitAmountMinor).toBe(2000);
    });

    it('computes exact totals in every minor unit, beyond 32-bit amounts', async () => {
      const xof = await fixture({
        currencyCode: 'XOF',
        currencyMinorUnit: 0,
        amount: () => 15_000,
      });
      const cfa = await bookingApi(alice).post('/bookings', holdBody(xof, 1, 2, ['1A', '1B']));
      expect(cfa.body).toMatchObject({
        unitAmountMinor: 15_000,
        totalAmountMinor: 30_000,
        currencyCode: 'XOF',
        currencyMinorUnit: 0,
      });
      const max = await fixture({ amount: () => 2_147_483_647 });
      const big = await bookingApi(alice).post(
        '/bookings',
        holdBody(max, 1, 2, ['1A', '1B', '2A']),
      );
      expect(big.body).toMatchObject({
        unitAmountMinor: 2_147_483_647,
        seatCount: 3,
        totalAmountMinor: 6_442_450_941,
      });
      expect(Number.isSafeInteger(big.body.totalAmountMinor)).toBe(true);
    });
  });

  describe('ownership', () => {
    it('lists and shows only the caller’s bookings, paginated by reference', async () => {
      const f = await fixture();
      const mine = [
        await bookingApi(alice).post('/bookings', holdBody(f, 1, 2, ['1A'])),
        await bookingApi(alice).post('/bookings', holdBody(f, 1, 2, ['1B'])),
      ];
      const theirs = await bookingApi(bob).post('/bookings', holdBody(f, 1, 2, ['2A']));
      const list = await bookingApi(alice).get('/bookings?limit=50');
      const references = (list.body.items as Array<{ reference: string }>).map(
        (item) => item.reference,
      );
      expect(references).toEqual(
        expect.arrayContaining(mine.map((response) => response.body.reference)),
      );
      expect(references).not.toContain(theirs.body.reference);
      const page = await bookingApi(alice).get('/bookings?limit=1');
      expect(page.body.items).toHaveLength(1);
      const next = await bookingApi(alice).get(`/bookings?limit=1&cursor=${page.body.nextCursor}`);
      expect(next.body.items[0].reference).not.toBe(page.body.items[0].reference);
      expect(
        (await bookingApi(bob).get(`/bookings?cursor=${mine[0]!.body.reference}`)).status,
      ).toBe(404);
      const detail = await bookingApi(alice).get(
        `/bookings/${mine[0]!.body.reference.toLowerCase()}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body.reference).toBe(mine[0]!.body.reference);
    });

    it('IDOR: another customer gets the same 404 as for an unknown booking, for reads and cancellations', async () => {
      const f = await fixture();
      const held = await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, ['1A']));
      const reference = held.body.reference as string;
      const unknown = 'ETB-0000000000AB';
      const foreignRead = await bookingApi(bob).get(`/bookings/${reference}`);
      const unknownRead = await bookingApi(bob).get(`/bookings/${unknown}`);
      expect(foreignRead.status).toBe(404);
      expect(withoutRequestId(foreignRead.body)).toEqual(withoutRequestId(unknownRead.body));
      expect(foreignRead.body.code).toBe('BOOKING_NOT_FOUND');
      const foreignCancel = await bookingApi(bob).post(`/bookings/${reference}/cancel`, {});
      const unknownCancel = await bookingApi(bob).post(`/bookings/${unknown}/cancel`, {});
      expect(foreignCancel.status).toBe(404);
      expect(withoutRequestId(foreignCancel.body)).toEqual(withoutRequestId(unknownCancel.body));
      expect((await bookingApi(bob).get('/bookings/not-a-reference')).status).toBe(404);
      expect(
        (await db(t.app).booking.findUniqueOrThrow({ where: { reference } })).cancelledAt,
      ).toBeNull();
    });
  });

  describe('cancellation and expiry', () => {
    it('cancels the owner’s active hold once and frees its seats immediately', async () => {
      const f = await fixture();
      const held = await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, ['1A', '1B']));
      const cancel = await bookingApi(alice).post(`/bookings/${held.body.reference}/cancel`, {});
      expect(cancel.status).toBe(200);
      expect(cancel.body).toMatchObject({ status: 'CANCELLED' });
      expect(
        cancel.body.seats.every((seat: { releasedAt: string | null }) => seat.releasedAt),
      ).toBe(true);
      const stored = await db(t.app).booking.findUniqueOrThrow({
        where: { reference: held.body.reference },
        include: { seats: true },
      });
      expect(stored.cancellationReason).toBe('Annulation par le client');
      expect(stored.seats).toHaveLength(2);
      expect(await db(t.app).seatInventoryLock.count({ where: { tripId: f.tripId } })).toBe(0);
      const again = await bookingApi(alice).post(`/bookings/${held.body.reference}/cancel`, {});
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('BOOKING_CANCELLED');
      expect((await bookingApi(bob).post('/bookings', holdBody(f, 1, 3, ['1A']))).status).toBe(201);
      const audit = await db(t.app).auditEvent.findFirstOrThrow({
        where: { resourceId: stored.id, action: 'BOOKING_CANCELLED' },
      });
      expect(audit).toMatchObject({ actorIdentityId: alice.id, actorRealm: 'CUSTOMER' });
      expect(
        (
          await bookingApi(alice).post(
            `/bookings/${held.body.reference}/cancel`,
            {},
            { csrf: null },
          )
        ).status,
      ).toBe(403);
    });

    it('derives EXPIRED from the database clock; an expired hold is not cancellable and frees its seat', async () => {
      const f = await fixture();
      const expired = await expiredHold(t.app, f, alice.id, 1, 3, ['2A']);
      const detail = await bookingApi(alice).get(`/bookings/${expired.reference}`);
      expect(detail.body.status).toBe('EXPIRED');
      const cancel = await bookingApi(alice).post(`/bookings/${expired.reference}/cancel`, {});
      expect(cancel.status).toBe(409);
      expect(cancel.body.code).toBe('BOOKING_EXPIRED');
      const reused = await bookingApi(bob).post('/bookings', holdBody(f, 2, 3, ['2A']));
      expect(reused.status).toBe(201);
      const seats = await db(t.app).bookingSeat.findMany({ where: { bookingId: expired.id } });
      expect(seats).toHaveLength(1);
      expect(seats[0]!.releasedAt).not.toBeNull();
      expect((await bookingApi(alice).get(`/bookings/${expired.reference}`)).body.status).toBe(
        'EXPIRED',
      );
    });
  });

  describe('audit atomicity', () => {
    it('rolls back creation and cancellation when their audit insert fails', async () => {
      const f = await fixture();
      const held = await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, ['1A']));
      await db(t.app).$executeRawUnsafe(`
        CREATE FUNCTION test_fail_booking_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action IN ('BOOKING_HELD', 'BOOKING_CANCELLED') THEN
            RAISE EXCEPTION 'simulated audit failure';
          END IF;
          RETURN NEW;
        END; $$`);
      await db(t.app).$executeRawUnsafe(
        'CREATE TRIGGER test_fail_booking_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_fail_booking_audit()',
      );
      try {
        const bookings = await db(t.app).booking.count();
        const seats = await db(t.app).bookingSeat.count();
        const locks = await db(t.app).seatInventoryLock.count();
        expect((await bookingApi(bob).post('/bookings', holdBody(f, 1, 3, ['2A']))).status).toBe(
          500,
        );
        expect(await db(t.app).booking.count()).toBe(bookings);
        expect(await db(t.app).bookingSeat.count()).toBe(seats);
        expect(await db(t.app).seatInventoryLock.count()).toBe(locks);
        expect(
          (await bookingApi(alice).post(`/bookings/${held.body.reference}/cancel`, {})).status,
        ).toBe(500);
        const stored = await db(t.app).booking.findUniqueOrThrow({
          where: { reference: held.body.reference },
          include: { seats: { include: { locks: true } } },
        });
        expect(stored.cancelledAt).toBeNull();
        expect(stored.seats[0]!.releasedAt).toBeNull();
        expect(stored.seats[0]!.locks).toHaveLength(2);
      } finally {
        await db(t.app).$executeRawUnsafe('DROP TRIGGER test_fail_booking_audit ON audit_event');
        await db(t.app).$executeRawUnsafe('DROP FUNCTION test_fail_booking_audit()');
      }
      expect((await bookingApi(bob).post('/bookings', holdBody(f, 1, 3, ['2A']))).status).toBe(201);
    });
  });
});
