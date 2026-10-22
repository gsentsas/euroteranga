import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase } from '../../support/admin-helpers.js';
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

const UNKNOWN_ID = '01900000-0000-7000-8000-000000000000';
const STOP_KEYS = ['code', 'country', 'id', 'locality', 'name', 'timezone'];
const RESULT_KEYS = [
  'availableSeatCount',
  'destination',
  'fare',
  'origin',
  'route',
  'seatCount',
  'tripId',
  'tripReference',
  'vehiclePrimaryMedia',
];

/** Public reads (no session): stops, search and availability. */
describe('public booking reads (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let customer: CustomerActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    countryId = await syntheticCountry(t.app);
    customer = await customerActor(t.app);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  /** Anonymous call from the booking app's origin (no cookie). */
  const anonymous = (path: string) =>
    request(t.app.getHttpServer()).get(`/v1/booking${path}`).set('Origin', 'http://localhost:3000');
  const search = (f: BookableFixture, origin: number, destination: number, extra = '') =>
    anonymous(
      `/trips?originStopId=${f.stopIds[origin - 1]}&destinationStopId=${f.stopIds[destination - 1]}${extra}`,
    );
  const availability = (f: BookableFixture, origin: string, destination: string) =>
    anonymous(
      `/trips/${f.tripId}/availability?originRouteWaypointId=${origin}&destinationRouteWaypointId=${destination}`,
    );
  const tripsOf = (response: request.Response) =>
    (response.body.items as Array<{ tripId: string }>).map((item) => item.tripId);

  describe('stops', () => {
    it('lists active stops only, with passenger-useful fields, without a session', async () => {
      const f = await bookableFixture(t.app, { countryId });
      await db(t.app).stop.update({ where: { id: f.stopIds[1]! }, data: { active: false } });
      const response = await anonymous('/stops?limit=50&query=réservation');
      expect(response.status).toBe(200);
      const items = response.body.items as Array<Record<string, unknown> & { id: string }>;
      expect(items.map((item) => item.id)).toContain(f.stopIds[0]);
      expect(items.map((item) => item.id)).not.toContain(f.stopIds[1]);
      for (const item of items) expect(Object.keys(item).sort()).toEqual(STOP_KEYS);
      expect(JSON.stringify(response.body)).not.toMatch(/latitude|longitude|createdAt|active/);
      const page = await anonymous('/stops?limit=1');
      expect(page.body.items).toHaveLength(1);
      expect(page.body.nextCursor).toBe(page.body.items[0].id);
      expect((await anonymous('/stops?limit=51')).status).toBe(400);
      expect((await anonymous(`/stops?query=${'x'.repeat(65)}`)).status).toBe(400);
    });
  });

  describe('search', () => {
    it('returns bookable journeys with an exact fare and live availability, without a session', async () => {
      const f = await bookableFixture(t.app, { countryId });
      const response = await search(f, 1, 3);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const [item] = response.body.items as Array<Record<string, unknown>>;
      expect(Object.keys(item!).sort()).toEqual(RESULT_KEYS);
      expect(item).toMatchObject({
        tripId: f.tripId,
        tripReference: f.tripReference,
        origin: { routeWaypointId: f.wp[1], stop: { id: f.stopIds[0] } },
        destination: { routeWaypointId: f.wp[3], stop: { id: f.stopIds[2] } },
        fare: { amountMinor: 2000, currencyCode: 'EUR', currencyMinorUnit: 2 },
        seatCount: 4,
        availableSeatCount: 4,
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /vin|registration|vehicleId|vehicleCode|vehicleName|email|customer|fareEntry|fareTable|seatMapVersion|audit/i,
      );
      expect(JSON.stringify(response.body)).not.toMatch(
        /costPlan|costItems|totalCostMinor|STOP_COST|SUPPORT_VEHICLE/,
      );
      await bookingApi(customer).post('/bookings', holdBody(f, 2, 4, ['1A', '1B']));
      expect((await search(f, 1, 3)).body.items[0].availableSeatCount).toBe(2);
      // [3,5) shares segment 3 with the hold [2,4).
      expect((await search(f, 3, 5)).body.items[0].availableSeatCount).toBe(2);
      // [4,5) is after the hold: every seat is free.
      expect((await search(f, 4, 5)).body.items[0].availableSeatCount).toBe(4);
      expect(tripsOf(await search(f, 1, 3, '&minAvailableSeats=3'))).not.toContain(f.tripId);
      expect(tripsOf(await search(f, 1, 3, '&minAvailableSeats=2'))).toContain(f.tripId);
    });

    it('excludes DRAFT, cancelled, departed, unconfigured trips and unpriced pairs', async () => {
      const draft = await bookableFixture(t.app, { countryId, status: 'DRAFT' });
      const cancelled = await bookableFixture(t.app, { countryId });
      await db(t.app).trip.update({
        where: { id: cancelled.tripId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      const departed = await bookableFixture(t.app, { countryId, departureInMs: -3_600_000 });
      const noSeatMap = await bookableFixture(t.app, { countryId, withSeatMap: false });
      const noPricing = await bookableFixture(t.app, { countryId, withPricing: false });
      for (const [label, fixture] of [
        ['draft', draft],
        ['cancelled', cancelled],
        ['departed', departed],
        ['no seat map', noSeatMap],
        ['no pricing', noPricing],
      ] as const) {
        const response = await search(fixture, 1, 3);
        expect(response.status, label).toBe(200);
        expect(tripsOf(response), label).not.toContain(fixture.tripId);
      }
      const unpriced = await bookableFixture(t.app, { countryId, unpricedPairs: ['1-3'] });
      expect(tripsOf(await search(unpriced, 1, 3))).not.toContain(unpriced.tripId);
      expect(tripsOf(await search(unpriced, 1, 4))).toContain(unpriced.tripId);
    });

    it('only offers boarding -> later alighting stop pairs', async () => {
      const f = await bookableFixture(t.app, { countryId, withCheckpoint: true });
      // Reversed order, W5 (no boarding) as origin, W1 (no alighting) as destination.
      for (const [origin, destination] of [
        [3, 1],
        [5, 4],
        [2, 1],
      ] as const) {
        expect(tripsOf(await search(f, origin, destination))).not.toContain(f.tripId);
      }
      // A checkpoint is not a stop: it cannot be searched.
      const checkpoint = await db(t.app).routeWaypoint.findUniqueOrThrow({
        where: { id: f.checkpointWaypointId! },
      });
      const byCheckpoint = await anonymous(
        `/trips?originStopId=${checkpoint.checkpointId}&destinationStopId=${f.stopIds[4]}`,
      );
      expect(byCheckpoint.body.items).toEqual([]);
      expect(
        (await anonymous(`/trips?originStopId=${f.stopIds[0]}&destinationStopId=${f.stopIds[0]}`))
          .status,
      ).toBe(400);
      expect((await anonymous(`/trips?originStopId=${f.stopIds[0]}`)).status).toBe(400);
    });

    it('returns one unambiguous result per waypoint pair when a stop repeats', async () => {
      const f = await bookableFixture(t.app, { countryId, repeatFirstStop: true });
      // The first stop is W1 and W4: both reach W5 with different fares.
      const response = await search(f, 1, 5);
      const items = (
        response.body.items as Array<{
          tripId: string;
          origin: { routeWaypointId: string };
          fare: { amountMinor: number };
        }>
      ).filter((item) => item.tripId === f.tripId);
      expect(items.map((item) => [item.origin.routeWaypointId, item.fare.amountMinor])).toEqual([
        [f.wp[1], 4000],
        [f.wp[4], 1000],
      ]);
    });

    it('filters by origin departure window and paginates with an opaque keyset cursor', async () => {
      const early = await bookableFixture(t.app, { countryId, departureInMs: 24 * 3_600_000 });
      // A second trip on the same stops, a day later.
      const late = await bookableFixture(t.app, {
        countryId,
        stopIds: early.stopIds,
        departureInMs: 48 * 3_600_000,
      });
      expect(tripsOf(await search(early, 1, 3))).toEqual([early.tripId, late.tripId]);
      const lateTrip = await db(t.app).trip.findUniqueOrThrow({ where: { id: late.tripId } });
      const around = (at: Date) =>
        `&departureFrom=${new Date(at.getTime() - 60_000).toISOString()}&departureTo=${new Date(at.getTime() + 60_000).toISOString()}`;
      expect(tripsOf(await search(early, 1, 3, around(lateTrip.plannedDepartureAt!)))).toEqual([
        late.tripId,
      ]);
      const page = await search(early, 1, 3, '&limit=1');
      expect(tripsOf(page)).toEqual([early.tripId]);
      expect(tripsOf(await search(early, 1, 3, `&limit=1&cursor=${page.body.nextCursor}`))).toEqual(
        [late.tripId],
      );
      // Pagination on a stop pair with several results (repeated stop: 2 pairs).
      const loop = await bookableFixture(t.app, { countryId, repeatFirstStop: true });
      const first = await search(loop, 1, 5, '&limit=1');
      expect(first.body.items).toHaveLength(1);
      expect(typeof first.body.nextCursor).toBe('string');
      const second = await search(loop, 1, 5, `&limit=1&cursor=${first.body.nextCursor}`);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.items[0].origin.routeWaypointId).not.toBe(
        first.body.items[0].origin.routeWaypointId,
      );
      expect(second.body.nextCursor).toBeNull();
      expect((await search(loop, 1, 5, '&cursor=not-a-cursor')).status).toBe(400);
      expect((await search(loop, 1, 5, '&limit=51')).status).toBe(400);
      expect(
        (
          await search(
            loop,
            1,
            5,
            `&departureFrom=2030-01-02T00:00:00Z&departureTo=2030-01-01T00:00:00Z`,
          )
        ).status,
      ).toBe(400);
    });
  });

  describe('availability', () => {
    it('shows the physical layout, seat availability per journey and the exact fare', async () => {
      const f = await bookableFixture(t.app, { countryId });
      const response = await availability(f, f.wp[1]!, f.wp[3]!);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        tripId: f.tripId,
        seatMapVersionId: f.seatMapVersionId,
        fare: { amountMinor: 2000, currencyCode: 'EUR', currencyMinorUnit: 2 },
        seatCount: 4,
        availableSeatCount: 4,
      });
      const cells = response.body.cells as Array<Record<string, unknown>>;
      expect(cells).toHaveLength(6);
      for (const cell of cells) {
        if (cell.kind === 'SEAT') {
          expect(Object.keys(cell).sort()).toEqual([
            'available',
            'column',
            'deck',
            'id',
            'kind',
            'row',
            'seatLabel',
          ]);
        } else {
          expect(cell).not.toHaveProperty('available');
        }
      }
    });

    it('occupies a held seat only on overlapping segments; expired and cancelled holds free it', async () => {
      const f = await bookableFixture(t.app, { countryId });
      const free = async (origin: number, destination: number) =>
        Object.fromEntries(
          (
            (await availability(f, f.wp[origin]!, f.wp[destination]!)).body.cells as Array<{
              seatLabel: string | null;
              available?: boolean;
            }>
          )
            .filter((cell) => cell.seatLabel)
            .map((cell) => [cell.seatLabel, cell.available]),
        );
      const held = await bookingApi(customer).post('/bookings', holdBody(f, 2, 4, ['1A']));
      expect((await free(2, 4))['1A']).toBe(false);
      expect((await free(1, 3))['1A']).toBe(false); // segment 2
      expect((await free(3, 5))['1A']).toBe(false); // segment 3
      expect((await free(1, 2))['1A']).toBe(true); // [1,2) before
      expect((await free(4, 5))['1A']).toBe(true); // [4,5) after
      expect(JSON.stringify((await availability(f, f.wp[1]!, f.wp[3]!)).body)).not.toContain(
        held.body.reference,
      );
      await bookingApi(customer).post(`/bookings/${held.body.reference}/cancel`, {});
      expect((await free(2, 4))['1A']).toBe(true);
      // An expired hold keeps stale locks until the next mutation: still free.
      await expiredHold(t.app, f, customer.id, 1, 5, ['2B']);
      expect(await db(t.app).seatInventoryLock.count({ where: { tripId: f.tripId } })).toBe(4);
      expect((await free(1, 5))['2B']).toBe(true);
    });

    it('reports why a journey cannot be booked', async () => {
      const f = await bookableFixture(t.app, {
        countryId,
        withCheckpoint: true,
        unpricedPairs: ['2-4'],
      });
      const expectError = async (response: request.Response, status: number, code: string) => {
        expect(response.status, code).toBe(status);
        expect(response.body.code).toBe(code);
      };
      await expectError(
        await anonymous(
          `/trips/${UNKNOWN_ID}/availability?originRouteWaypointId=${f.wp[1]}&destinationRouteWaypointId=${f.wp[3]}`,
        ),
        404,
        'BOOKING_TRIP_NOT_BOOKABLE',
      );
      const draft = await bookableFixture(t.app, { countryId, status: 'DRAFT' });
      await expectError(
        await availability(draft, draft.wp[1]!, draft.wp[3]!),
        404,
        'BOOKING_TRIP_NOT_BOOKABLE',
      );
      const departed = await bookableFixture(t.app, { countryId, departureInMs: -3_600_000 });
      await expectError(
        await availability(departed, departed.wp[1]!, departed.wp[3]!),
        422,
        'BOOKING_TRIP_DEPARTED',
      );
      const noSeatMap = await bookableFixture(t.app, { countryId, withSeatMap: false });
      await expectError(
        await availability(noSeatMap, noSeatMap.wp[1]!, noSeatMap.wp[3]!),
        422,
        'BOOKING_SEAT_MAP_NOT_CONFIGURED',
      );
      const noPricing = await bookableFixture(t.app, { countryId, withPricing: false });
      await expectError(
        await availability(noPricing, noPricing.wp[1]!, noPricing.wp[3]!),
        422,
        'BOOKING_PRICING_NOT_CONFIGURED',
      );
      await expectError(await availability(f, f.wp[3]!, f.wp[1]!), 422, 'BOOKING_OD_INVALID');
      await expectError(
        await availability(f, f.wp[1]!, f.checkpointWaypointId!),
        422,
        'BOOKING_OD_INVALID',
      );
      await expectError(await availability(f, f.wp[5]!, f.wp[5]!), 422, 'BOOKING_OD_INVALID');
      const other = await bookableFixture(t.app, { countryId });
      await expectError(
        await availability(f, other.wp[1]!, other.wp[3]!),
        422,
        'BOOKING_OD_INVALID',
      );
      await expectError(
        await availability(f, f.wp[2]!, f.wp[4]!),
        404,
        'BOOKING_FARE_NOT_CONFIGURED',
      );
      expect(
        (
          await anonymous(
            `/trips/not-a-uuid/availability?originRouteWaypointId=${f.wp[1]}&destinationRouteWaypointId=${f.wp[3]}`,
          )
        ).status,
      ).toBe(400);
      const raw = JSON.stringify((await availability(f, f.wp[3]!, f.wp[1]!)).body);
      expect(raw).not.toMatch(/prisma|postgres|SQL/i);
    });
  });
});
