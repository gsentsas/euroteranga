import { Prisma } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { createIdentity, db } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  expiredHold,
  syntheticCountry,
  type BookableFixture,
} from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * PostgreSQL guards of the booking domain, exercised directly (Prisma and raw
 * SQL) on an isolated database: they protect the inventory against every
 * writer, not only the API.
 */
describe('booking database invariants (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let customerId: string;
  let f: BookableFixture;
  let counter = 0;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    countryId = await syntheticCountry(t.app);
    customerId = (await createIdentity(t.app, { realm: 'customer' })).id;
    f = await bookableFixture(t.app, { countryId });
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const nextReference = () => {
    counter += 1;
    return `ETB-TEST${String(counter).padStart(8, '0')}`;
  };

  async function now(): Promise<Date> {
    const [row] = await db(t.app).$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`;
    return row!.now;
  }

  /** A valid booking row for origin -> destination (stop indexes 1..5). */
  async function bookingData(
    fixture: BookableFixture,
    origin = 1,
    destination = 3,
    overrides: Partial<Prisma.BookingUncheckedCreateInput> = {},
  ): Promise<Prisma.BookingUncheckedCreateInput> {
    const [o, d] = await Promise.all([
      db(t.app).routeWaypoint.findUniqueOrThrow({ where: { id: fixture.wp[origin]! } }),
      db(t.app).routeWaypoint.findUniqueOrThrow({ where: { id: fixture.wp[destination]! } }),
    ]);
    const fare = await db(t.app).fareEntry.findFirst({
      where: {
        fareTableVersionId: fixture.fareTableVersionId,
        originRouteWaypointId: o.id,
        destinationRouteWaypointId: d.id,
      },
    });
    const at = await now();
    return {
      reference: nextReference(),
      customerIdentityId: customerId,
      tripId: fixture.tripId,
      originRouteWaypointId: o.id,
      destinationRouteWaypointId: d.id,
      originSequence: o.sequence,
      destinationSequence: d.sequence,
      fareEntryId: fare?.id ?? '01900000-0000-7000-8000-000000000000',
      unitAmountMinor: fare?.amountMinor ?? 1000,
      currencyCode: fixture.currencyCode,
      currencyMinorUnit: fixture.currencyMinorUnit,
      createdAt: at,
      holdExpiresAt: new Date(at.getTime() + 600_000),
      ...overrides,
    };
  }

  const insert = async (data: Prisma.BookingUncheckedCreateInput) =>
    db(t.app).booking.create({ data });

  /** An active hold on `seats` for origin -> destination, with its locks. */
  async function activeHold(
    fixture: BookableFixture,
    origin: number,
    destination: number,
    seats: string[],
  ) {
    const booking = await insert(await bookingData(fixture, origin, destination));
    for (const label of seats) {
      const seat = await db(t.app).bookingSeat.create({
        data: {
          bookingId: booking.id,
          seatMapCellId: fixture.cells[label]!,
          createdAt: booking.createdAt,
        },
      });
      for (
        let segment = booking.originSequence;
        segment < booking.destinationSequence;
        segment += 1
      ) {
        await db(t.app).seatInventoryLock.create({
          data: {
            bookingSeatId: seat.id,
            tripId: fixture.tripId,
            seatMapCellId: seat.seatMapCellId,
            segmentSequence: segment,
          },
        });
      }
    }
    return booking;
  }

  describe('booking creation', () => {
    it('accepts a valid hold and enforces the documented CHECKs', async () => {
      await expect(insert(await bookingData(f))).resolves.toMatchObject({ unitAmountMinor: 2000 });
      for (const [reference, label] of [
        ['BOOKING-000001', 'sequential'],
        ['ETB-abcdefghijkl', 'lowercase'],
        ['ETB-0000000000IL', 'ambiguous letters'],
      ] as const) {
        await expect(insert(await bookingData(f, 1, 3, { reference })), label).rejects.toThrow(
          /booking_reference_format/,
        );
      }
      const at = await now();
      await expect(
        insert(await bookingData(f, 1, 3, { holdExpiresAt: at, createdAt: at })),
      ).rejects.toThrow(/booking_hold_after_creation/);
      await expect(insert(await bookingData(f, 1, 3, { unitAmountMinor: 0 }))).rejects.toThrow(
        /booking_unit_amount_positive|exact snapshot/,
      );
      await expect(
        insert(await bookingData(f, 1, 3, { cancelledAt: at, cancellationReason: 'x' })),
      ).rejects.toThrow(/created as active holds/);
      // Some CHECKs are preempted by the guard (a fare is always > 0, the
      // snapshot rule fires first): their presence is asserted in the catalogue.
      const checks = await db(t.app).$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE conrelid IN ('booking'::regclass, 'booking_seat'::regclass, 'seat_inventory_lock'::regclass)
          AND contype = 'c'
        ORDER BY conname`;
      expect(checks.map((check) => check.conname)).toEqual([
        'booking_cancellation_consistent',
        'booking_currency_code_format',
        'booking_currency_minor_unit_range',
        'booking_hold_after_creation',
        'booking_reference_format',
        'booking_seat_released_after_creation',
        'booking_sequences_ordered',
        'booking_unit_amount_positive',
        'seat_inventory_lock_segment_positive',
      ]);
    });

    it('requires an ACTIVE CUSTOMER identity', async () => {
      const staff = await createIdentity(t.app, { realm: 'staff' });
      await expect(
        insert(await bookingData(f, 1, 3, { customerIdentityId: staff.id })),
      ).rejects.toThrow(/belongs to a CUSTOMER identity/);
      const suspended = await createIdentity(t.app, { realm: 'customer', status: 'SUSPENDED' });
      await expect(
        insert(await bookingData(f, 1, 3, { customerIdentityId: suspended.id })),
      ).rejects.toThrow(/only an ACTIVE customer/);
    });

    it('requires a SCHEDULED trip not yet departed, with seat map and pricing', async () => {
      const draft = await bookableFixture(t.app, { countryId, status: 'DRAFT' });
      await expect(insert(await bookingData(draft))).rejects.toThrow(/only a SCHEDULED trip/);
      const departed = await bookableFixture(t.app, { countryId, departureInMs: -3_600_000 });
      const data = await bookingData(departed);
      await expect(
        insert({ ...data, holdExpiresAt: new Date((data.createdAt!.valueOf() as number) + 1) }),
      ).rejects.toThrow(/has departed/);
      const noSeatMap = await bookableFixture(t.app, { countryId, withSeatMap: false });
      await expect(insert(await bookingData(noSeatMap))).rejects.toThrow(/needs a seat map/);
      const noPricing = await bookableFixture(t.app, { countryId, withPricing: false });
      await expect(insert(await bookingData(noPricing))).rejects.toThrow(/needs pricing/);
      const trip = await db(t.app).trip.findUniqueOrThrow({ where: { id: f.tripId } });
      await expect(
        insert(
          await bookingData(f, 1, 3, {
            holdExpiresAt: new Date(trip.plannedDepartureAt!.getTime() + 1),
          }),
        ),
      ).rejects.toThrow(/cannot outlast the trip departure/);
    });

    it('requires an exact, valid origin/destination of the trip route version', async () => {
      const other = await bookableFixture(t.app, { countryId });
      await expect(
        insert(await bookingData(f, 1, 3, { originRouteWaypointId: other.wp[1]! })),
      ).rejects.toThrow(/must belong to the trip route version/);
      const withCheckpoint = await bookableFixture(t.app, { countryId, withCheckpoint: true });
      const checkpoint = await db(t.app).routeWaypoint.findUniqueOrThrow({
        where: { id: withCheckpoint.checkpointWaypointId! },
      });
      await expect(
        insert(
          await bookingData(withCheckpoint, 1, 4, {
            destinationRouteWaypointId: checkpoint.id,
            destinationSequence: checkpoint.sequence,
          }),
        ),
      ).rejects.toThrow(/between stops only/);
      // W5 never allows boarding, W1 never allows alighting.
      const w5 = await db(t.app).routeWaypoint.findUniqueOrThrow({ where: { id: f.wp[5]! } });
      await expect(
        insert(
          await bookingData(f, 4, 5, { originRouteWaypointId: w5.id, originSequence: w5.sequence }),
        ),
      ).rejects.toThrow(/origin must allow boarding/);
      const w1 = await db(t.app).routeWaypoint.findUniqueOrThrow({ where: { id: f.wp[1]! } });
      await expect(
        insert(
          await bookingData(f, 1, 2, {
            destinationRouteWaypointId: w1.id,
            destinationSequence: w1.sequence + 1,
          }),
        ),
      ).rejects.toThrow(/destination must allow alighting/);
      const [w2, w4] = await Promise.all([
        db(t.app).routeWaypoint.findUniqueOrThrow({ where: { id: f.wp[2]! } }),
        db(t.app).routeWaypoint.findUniqueOrThrow({ where: { id: f.wp[4]! } }),
      ]);
      await expect(
        insert(
          await bookingData(f, 2, 4, {
            originRouteWaypointId: w4.id,
            destinationRouteWaypointId: w2.id,
          }),
        ),
      ).rejects.toThrow(/origin must come before the destination/);
      await expect(insert(await bookingData(f, 2, 4, { originSequence: 1 }))).rejects.toThrow(
        /sequences must be those of its waypoints/,
      );
    });

    it('requires the exact fare of the trip pricing and its exact snapshot', async () => {
      const other = await bookableFixture(t.app, { countryId });
      const foreignFare = await db(t.app).fareEntry.findFirstOrThrow({
        where: { fareTableVersionId: other.fareTableVersionId },
      });
      await expect(
        insert(await bookingData(f, 1, 3, { fareEntryId: foreignFare.id })),
      ).rejects.toThrow(/must belong to the trip pricing/);
      const otherPair = await db(t.app).fareEntry.findFirstOrThrow({
        where: {
          fareTableVersionId: f.fareTableVersionId,
          originRouteWaypointId: f.wp[1]!,
          destinationRouteWaypointId: f.wp[4]!,
        },
      });
      await expect(
        insert(await bookingData(f, 1, 3, { fareEntryId: otherPair.id })),
      ).rejects.toThrow(/price exactly its origin and destination/);
      for (const change of [
        { unitAmountMinor: 1999 },
        { currencyCode: 'XOF' },
        { currencyMinorUnit: 0 },
      ]) {
        await expect(insert(await bookingData(f, 1, 3, change))).rejects.toThrow(
          /exact snapshot of its fare/,
        );
      }
    });
  });

  describe('booking history', () => {
    it('is immutable except for one cancellation of an active hold; never deleted', async () => {
      const booking = await insert(await bookingData(f));
      const changes: Array<Prisma.BookingUncheckedUpdateInput> = [
        { reference: nextReference() },
        { customerIdentityId: (await createIdentity(t.app, { realm: 'customer' })).id },
        { tripId: (await bookableFixture(t.app, { countryId })).tripId },
        { destinationRouteWaypointId: f.wp[4]! },
        { originSequence: 2 },
        { unitAmountMinor: 1 },
        { currencyCode: 'XOF' },
        { holdExpiresAt: new Date(booking.holdExpiresAt.getTime() + 60_000) },
        { createdAt: new Date(0) },
      ];
      for (const change of changes) {
        await expect(
          db(t.app).booking.update({ where: { id: booking.id }, data: change }),
          JSON.stringify(Object.keys(change)),
        ).rejects.toThrow(/immutable/);
      }
      await expect(db(t.app).booking.delete({ where: { id: booking.id } })).rejects.toThrow(
        /cannot be deleted/,
      );
      await expect(
        db(t.app).$executeRawUnsafe(`DELETE FROM "booking" WHERE "id" = '${booking.id}'`),
      ).rejects.toThrow(/cannot be deleted/);
      const at = await now();
      await db(t.app).booking.update({
        where: { id: booking.id },
        data: { cancelledAt: at, cancellationReason: 'Test' },
      });
      await expect(
        db(t.app).booking.update({
          where: { id: booking.id },
          data: { cancellationReason: 'Autre' },
        }),
      ).rejects.toThrow(/cancelled bookings are immutable/);
      const expired = await expiredHold(t.app, f, customerId, 1, 2, ['2B']);
      await expect(
        db(t.app).booking.update({
          where: { id: expired.id },
          data: { cancelledAt: await now(), cancellationReason: 'Trop tard' },
        }),
      ).rejects.toThrow(/an expired hold cannot be cancelled/);
    });
  });

  describe('booking seats', () => {
    it('only SEAT cells of the trip historical seat map, historical and released once', async () => {
      const booking = await insert(await bookingData(f, 1, 2));
      const seat = (label: string) =>
        db(t.app).bookingSeat.create({
          data: {
            bookingId: booking.id,
            seatMapCellId: f.cells[label]!,
            createdAt: booking.createdAt,
          },
        });
      await expect(seat('AISLE')).rejects.toThrow(/only SEAT cells can be booked/);
      await expect(seat('DRIVER')).rejects.toThrow(/only SEAT cells can be booked/);
      const other = await bookableFixture(t.app, { countryId });
      await expect(
        db(t.app).bookingSeat.create({
          data: {
            bookingId: booking.id,
            seatMapCellId: other.cells['1A']!,
            createdAt: booking.createdAt,
          },
        }),
      ).rejects.toThrow(/must belong to the trip seat map/);
      const created = await seat('1A');
      await expect(seat('1A')).rejects.toThrow(); // unique (booking, cell)
      await expect(
        db(t.app).bookingSeat.update({
          where: { id: created.id },
          data: { seatMapCellId: f.cells['1B']! },
        }),
      ).rejects.toThrow(/a booking seat cannot change/);
      await expect(
        db(t.app).bookingSeat.update({
          where: { id: created.id },
          data: { releasedAt: await now() },
        }),
      ).rejects.toThrow(/a seat of an active hold cannot be released/);
      await expect(db(t.app).bookingSeat.delete({ where: { id: created.id } })).rejects.toThrow(
        /historical and cannot be deleted/,
      );
      const at = await now();
      await db(t.app).booking.update({
        where: { id: booking.id },
        data: { cancelledAt: at, cancellationReason: 'Test' },
      });
      await db(t.app).bookingSeat.update({ where: { id: created.id }, data: { releasedAt: at } });
      await expect(
        db(t.app).bookingSeat.update({
          where: { id: created.id },
          data: { releasedAt: new Date(at.getTime() + 1000) },
        }),
      ).rejects.toThrow(/released booking seat is final/);
      await expect(seat('1B')).rejects.toThrow(/seats can only be added to an active hold/);
    });
  });

  describe('seat inventory locks', () => {
    it('cover only segments [origin, destination) of an active hold, once per trip seat', async () => {
      const g = await bookableFixture(t.app, { countryId });
      const booking = await insert(await bookingData(g, 2, 4)); // segments 2 and 3
      const seat = await db(t.app).bookingSeat.create({
        data: {
          bookingId: booking.id,
          seatMapCellId: g.cells['1A']!,
          createdAt: booking.createdAt,
        },
      });
      const lock = (segmentSequence: number, overrides: Record<string, string> = {}) =>
        db(t.app).seatInventoryLock.create({
          data: {
            bookingSeatId: seat.id,
            tripId: g.tripId,
            seatMapCellId: seat.seatMapCellId,
            segmentSequence,
            ...overrides,
          },
        });
      await expect(lock(1)).rejects.toThrow(/cover a segment of its booking journey/);
      await expect(lock(4)).rejects.toThrow(/cover a segment of its booking journey/);
      await expect(lock(2, { seatMapCellId: g.cells['1B']! })).rejects.toThrow(
        /match its booking seat and trip/,
      );
      const created = await lock(2);
      await lock(3);
      await expect(lock(3)).rejects.toThrow(); // unique (booking seat, segment)
      // A second hold cannot take the same trip seat on the same segment.
      const rival = await insert(await bookingData(g, 3, 5));
      const rivalSeat = await db(t.app).bookingSeat.create({
        data: { bookingId: rival.id, seatMapCellId: g.cells['1A']!, createdAt: rival.createdAt },
      });
      await expect(
        db(t.app).seatInventoryLock.create({
          data: {
            bookingSeatId: rivalSeat.id,
            tripId: g.tripId,
            seatMapCellId: rivalSeat.seatMapCellId,
            segmentSequence: 3,
          },
        }),
      ).rejects.toThrow(/Unique constraint|unique/i);
      await expect(
        db(t.app).seatInventoryLock.update({
          where: { id: created.id },
          data: { segmentSequence: 3 },
        }),
      ).rejects.toThrow(/locks are immutable/);
      await expect(
        db(t.app).$executeRawUnsafe(
          `DELETE FROM "seat_inventory_lock" WHERE "id" = '${created.id}'`,
        ),
      ).rejects.toThrow(/seat lock of an active hold cannot be deleted/);
      await db(t.app).booking.update({
        where: { id: booking.id },
        data: { cancelledAt: await now(), cancellationReason: 'Test' },
      });
      await expect(
        db(t.app).$executeRawUnsafe(
          `DELETE FROM "seat_inventory_lock" WHERE "id" = '${created.id}'`,
        ),
      ).resolves.toBe(1);
      await expect(lock(3)).rejects.toThrow(/only an active hold can lock seats/);
    });

    it('lets the locks of an expired hold be deleted, and only those', async () => {
      const g = await bookableFixture(t.app, { countryId });
      const expired = await expiredHold(t.app, g, customerId, 1, 3, ['2A']);
      const active = await activeHold(g, 3, 5, ['2A']);
      expect(
        await db(t.app).$executeRawUnsafe(
          `DELETE FROM "seat_inventory_lock" l USING "booking_seat" bs WHERE l."booking_seat_id" = bs."id" AND bs."booking_id" = '${expired.id}'`,
        ),
      ).toBe(2);
      await expect(
        db(t.app).$executeRawUnsafe(
          `DELETE FROM "seat_inventory_lock" l USING "booking_seat" bs WHERE l."booking_seat_id" = bs."id" AND bs."booking_id" = '${active.id}'`,
        ),
      ).rejects.toThrow(/seat lock of an active hold cannot be deleted/);
    });
  });

  describe('truncation and trips', () => {
    it('refuses TRUNCATE on the three tables (plain stops at foreign keys, CASCADE at the trigger)', async () => {
      await expect(
        db(t.app).$executeRawUnsafe('TRUNCATE TABLE "seat_inventory_lock"'),
      ).rejects.toThrow(/cannot be truncated/);
      for (const table of ['booking', 'booking_seat']) {
        await expect(
          db(t.app).$executeRawUnsafe(`TRUNCATE TABLE "${table}"`),
          table,
        ).rejects.toThrow(/referenced in a foreign key constraint/);
        await expect(
          db(t.app).$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`),
          table,
        ).rejects.toThrow(/booking history and seat inventory cannot be truncated/);
      }
      expect(await db(t.app).booking.count()).toBeGreaterThan(0);
    });

    it('refuses to cancel a trip that still has active holds', async () => {
      const g = await bookableFixture(t.app, { countryId });
      const booking = await activeHold(g, 1, 3, ['1B']);
      await expect(
        db(t.app).$executeRawUnsafe(
          `UPDATE "trip" SET "status" = 'CANCELLED', "cancelled_at" = now() WHERE "id" = '${g.tripId}'`,
        ),
      ).rejects.toThrow(/a trip with active booking holds cannot be cancelled/);
      await db(t.app).booking.update({
        where: { id: booking.id },
        data: { cancelledAt: await now(), cancellationReason: 'Test' },
      });
      await db(t.app).$executeRawUnsafe(
        `UPDATE "trip" SET "status" = 'CANCELLED', "cancelled_at" = now() WHERE "id" = '${g.tripId}'`,
      );
      await expect(insert(await bookingData(g))).rejects.toThrow(/only a SCHEDULED trip/);
    });

    it('grants booking.read / booking.manage exactly as documented', async () => {
      const grants = await db(t.app).authorizationRolePermission.findMany({
        where: { permissionKey: { startsWith: 'booking.' } },
        orderBy: [{ roleKey: 'asc' }, { permissionKey: 'asc' }],
        select: { roleKey: true, permissionKey: true },
      });
      const managers = [
        'BOOKING_AGENT',
        'CUSTOMER_SUPPORT',
        'DIRECTOR',
        'OPS_MANAGER',
        'SUPER_ADMIN',
      ];
      expect(grants).toEqual(
        managers.flatMap((roleKey) => [
          { roleKey, permissionKey: 'booking.manage' },
          { roleKey, permissionKey: 'booking.read' },
        ]),
      );
      const managerWithoutRead = await db(t.app).$queryRaw<Array<{ role_key: string }>>`
        SELECT m."role_key" FROM "authorization_role_permission" m
        WHERE m."permission_key" = 'booking.manage'
          AND NOT EXISTS (
            SELECT 1 FROM "authorization_role_permission" r
            WHERE r."role_key" = m."role_key" AND r."permission_key" = 'booking.read'
          )`;
      expect(managerWithoutRead).toEqual([]);
    });
  });
});
