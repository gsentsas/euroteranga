import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const HOUR = 3_600_000;
const BASE = Date.UTC(2030, 0, 15, 8, 0, 0);
const at = (hours: number) => new Date(BASE + hours * HOUR);

/**
 * Trip and timetable invariants proven through direct database writes
 * (Prisma and raw SQL), bypassing the API. Synthetic data only.
 */
describe('trip database invariants (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    countryId = (
      await db(t.app).country.create({ data: { iso2: 'QT', iso3: 'QTT', name: 'Pays T' } })
    ).id;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const suffix = () => randomBytes(4).toString('hex').toUpperCase();
  const reference = () => `ET-TEST-2030-${suffix()}`;

  async function place(kind: 'stop' | 'checkpoint') {
    const data = {
      code: `${kind === 'stop' ? 'S' : 'C'}_${suffix()}`,
      name: `Point ${kind}`,
      countryId,
      locality: 'Localité',
      latitude: 10,
      longitude: 10,
      timezone: 'Etc/UTC',
    };
    return kind === 'stop'
      ? db(t.app).stop.create({ data })
      : db(t.app).checkpoint.create({ data: { ...data, type: 'TECHNICAL' } });
  }

  /** Route version stop -> checkpoint -> stop, optionally published. */
  async function routeVersion(publish = true) {
    const [a, c, b] = [await place('stop'), await place('checkpoint'), await place('stop')];
    const route = await db(t.app).route.create({ data: { code: `R_${suffix()}`, name: 'Route' } });
    const version = await db(t.app).routeVersion.create({
      data: { routeId: route.id, version: 1 },
    });
    await db(t.app).routeWaypoint.createMany({
      data: [
        { routeVersionId: version.id, sequence: 1, stopId: a.id, boardingAllowed: true },
        { routeVersionId: version.id, sequence: 2, checkpointId: c.id },
        { routeVersionId: version.id, sequence: 3, stopId: b.id, alightingAllowed: true },
      ],
    });
    if (publish) {
      await db(t.app).routeVersion.update({
        where: { id: version.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    }
    const waypoints = await db(t.app).routeWaypoint.findMany({
      where: { routeVersionId: version.id },
      orderBy: { sequence: 'asc' },
    });
    return { route, version, waypoints };
  }

  async function vehicle(status: 'PLANNED' | 'ACTIVE' | 'OUT_OF_SERVICE' | 'RETIRED' = 'ACTIVE') {
    const created = await db(t.app).vehicle.create({
      data: { code: `VH_${suffix()}`, manufacturer: 'Constructeur', model: 'Modèle' },
    });
    const path: Record<string, string[]> = {
      PLANNED: [],
      ACTIVE: ['ACTIVE'],
      OUT_OF_SERVICE: ['ACTIVE', 'OUT_OF_SERVICE'],
      RETIRED: ['RETIRED'],
    };
    for (const next of path[status] ?? []) {
      await db(t.app).vehicle.update({
        where: { id: created.id },
        data: {
          status: next as 'ACTIVE',
          retiredAt: next === 'RETIRED' ? new Date() : null,
        },
      });
    }
    return created;
  }

  /** A DRAFT trip with a complete, valid timetable (08:00 -> 10:00/10:15 -> 12:00). */
  async function draftWithTimetable(vehicleId?: string) {
    const { version, waypoints } = await routeVersion();
    const trip = await db(t.app).trip.create({
      data: {
        reference: reference(),
        routeVersionId: version.id,
        ...(vehicleId ? { vehicleId } : {}),
      },
    });
    const [first, middle, last] = waypoints;
    await db(t.app).tripWaypointTiming.createMany({
      data: [
        { tripId: trip.id, routeWaypointId: first!.id, sequence: 1, plannedDepartureAt: at(0) },
        {
          tripId: trip.id,
          routeWaypointId: middle!.id,
          sequence: 2,
          plannedArrivalAt: at(2),
          plannedDepartureAt: at(2.25),
        },
        { tripId: trip.id, routeWaypointId: last!.id, sequence: 3, plannedArrivalAt: at(4) },
      ],
    });
    await db(t.app).trip.update({
      where: { id: trip.id },
      data: { plannedDepartureAt: at(0), plannedArrivalAt: at(4) },
    });
    const timings = await db(t.app).tripWaypointTiming.findMany({
      where: { tripId: trip.id },
      orderBy: { sequence: 'asc' },
    });
    return { trip, version, waypoints, timings };
  }

  const schedule = (id: string) =>
    db(t.app).trip.update({
      where: { id },
      data: { status: 'SCHEDULED', scheduledAt: new Date() },
    });
  const cancel = (id: string) =>
    db(t.app).trip.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

  it('requires a unique, normalized reference', async () => {
    const { version } = await routeVersion();
    await db(t.app).trip.create({
      data: { reference: 'ET-TEST-2030-0001', routeVersionId: version.id },
    });
    await expect(
      db(t.app).trip.create({
        data: { reference: 'ET-TEST-2030-0001', routeVersionId: version.id },
      }),
    ).rejects.toThrow();
    for (const bad of [
      'et-test-2030-0002',
      ' ET-TEST-2030-0003',
      'ET TEST 2030',
      'E',
      '-ET-TEST',
    ]) {
      await expect(
        db(t.app).trip.create({ data: { reference: bad, routeVersionId: version.id } }),
      ).rejects.toThrow(/trip_reference_normalized/);
    }
  });

  it('creates trips as DRAFT, on a route version that has been published', async () => {
    const draftVersion = await routeVersion(false);
    await expect(
      db(t.app).trip.create({
        data: { reference: reference(), routeVersionId: draftVersion.version.id },
      }),
    ).rejects.toThrow(/route version that has been published/);
    await expect(
      db(t.app).trip.create({
        data: { reference: reference(), routeVersionId: '01900000-0000-7000-8000-000000000000' },
      }),
    ).rejects.toThrow();
    const { version } = await routeVersion();
    await expect(
      db(t.app).trip.create({
        data: {
          reference: reference(),
          routeVersionId: version.id,
          status: 'SCHEDULED',
          scheduledAt: new Date(),
        },
      }),
    ).rejects.toThrow(/must be created as DRAFT/);
  });

  it('keeps reference and route version immutable', async () => {
    const { trip } = await draftWithTimetable();
    const other = await routeVersion();
    await expect(
      db(t.app).trip.update({ where: { id: trip.id }, data: { reference: reference() } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      db(t.app).trip.update({ where: { id: trip.id }, data: { routeVersionId: other.version.id } }),
    ).rejects.toThrow(/immutable/);
  });

  it('keeps timestamps consistent with the status', async () => {
    const { trip } = await draftWithTimetable();
    await expect(
      db(t.app).trip.update({ where: { id: trip.id }, data: { scheduledAt: new Date() } }),
    ).rejects.toThrow(/trip_scheduled_at_consistent/);
    await expect(
      db(t.app).trip.update({ where: { id: trip.id }, data: { cancelledAt: new Date() } }),
    ).rejects.toThrow(/trip_cancelled_at_consistent/);
    await expect(
      db(t.app).trip.update({ where: { id: trip.id }, data: { status: 'SCHEDULED' } }),
    ).rejects.toThrow(/trip_scheduled_at_consistent/);
    await expect(
      db(t.app).trip.update({
        where: { id: trip.id },
        data: { plannedDepartureAt: at(5), plannedArrivalAt: at(4) },
      }),
    ).rejects.toThrow(/trip_planned_times_consistent/);
  });

  it('follows the lifecycle; CANCELLED is terminal and frozen', async () => {
    const scheduled = await draftWithTimetable();
    await expect(schedule(scheduled.trip.id)).resolves.toMatchObject({ status: 'SCHEDULED' });
    await expect(
      db(t.app).trip.update({
        where: { id: scheduled.trip.id },
        data: { status: 'DRAFT', scheduledAt: null },
      }),
    ).rejects.toThrow(/invalid trip status transition/);
    await expect(cancel(scheduled.trip.id)).resolves.toMatchObject({ status: 'CANCELLED' });
    const cancelled = await db(t.app).trip.findUniqueOrThrow({ where: { id: scheduled.trip.id } });
    expect(cancelled.scheduledAt).not.toBeNull(); // kept after cancellation

    await expect(
      db(t.app).trip.update({
        where: { id: scheduled.trip.id },
        data: { status: 'SCHEDULED', cancelledAt: null },
      }),
    ).rejects.toThrow(/cancelled trips are immutable/);
    await expect(
      db(t.app).$executeRawUnsafe(
        `UPDATE "trip" SET "updated_at" = now() WHERE "id" = '${scheduled.trip.id}'`,
      ),
    ).rejects.toThrow(/cancelled trips are immutable/);

    const draft = await draftWithTimetable();
    await expect(cancel(draft.trip.id)).resolves.toMatchObject({
      status: 'CANCELLED',
      scheduledAt: null,
    });
  });

  it('enforces timing uniqueness, sequence and membership in the route version', async () => {
    const { trip, waypoints } = await draftWithTimetable();
    const other = await routeVersion();
    const [first] = waypoints;
    await expect(
      db(t.app).tripWaypointTiming.create({
        data: {
          tripId: trip.id,
          routeWaypointId: other.waypoints[1]!.id,
          sequence: 2,
          plannedArrivalAt: at(1),
          plannedDepartureAt: at(1),
        },
      }),
    ).rejects.toThrow(); // sequence 2 already used
    await db(t.app).tripWaypointTiming.deleteMany({ where: { tripId: trip.id, sequence: 2 } });
    await expect(
      db(t.app).tripWaypointTiming.create({
        data: {
          tripId: trip.id,
          routeWaypointId: other.waypoints[1]!.id,
          sequence: 2,
          plannedArrivalAt: at(1),
          plannedDepartureAt: at(1),
        },
      }),
    ).rejects.toThrow(/waypoint of the trip route version/);
    await expect(
      db(t.app).tripWaypointTiming.create({
        data: {
          tripId: trip.id,
          routeWaypointId: waypoints[1]!.id,
          sequence: 5,
          plannedArrivalAt: at(1),
          plannedDepartureAt: at(1),
        },
      }),
    ).rejects.toThrow(/sequence must match/);
    await expect(
      db(t.app).tripWaypointTiming.create({
        data: {
          tripId: trip.id,
          routeWaypointId: first!.id,
          sequence: 2,
          plannedArrivalAt: at(1),
          plannedDepartureAt: at(1),
        },
      }),
    ).rejects.toThrow(); // same waypoint twice
    await expect(
      db(t.app).tripWaypointTiming.create({
        data: {
          tripId: trip.id,
          routeWaypointId: waypoints[1]!.id,
          sequence: 0,
          plannedArrivalAt: at(1),
        },
      }),
    ).rejects.toThrow(/sequence must match|trip_waypoint_timing_sequence_positive/);
    // The trigger runs before CHECK constraints; the CHECK is a second barrier.
    const checks = await db(t.app).$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'trip_waypoint_timing'::regclass AND contype = 'c' ORDER BY conname
    `;
    expect(checks.map((row) => row.conname)).toEqual([
      'trip_waypoint_timing_dwell_order',
      'trip_waypoint_timing_has_time',
      'trip_waypoint_timing_sequence_positive',
    ]);
    await expect(
      db(t.app).tripWaypointTiming.create({
        data: { tripId: trip.id, routeWaypointId: waypoints[1]!.id, sequence: 2 },
      }),
    ).rejects.toThrow(/trip_waypoint_timing_has_time/);
    await expect(
      db(t.app).tripWaypointTiming.create({
        data: {
          tripId: trip.id,
          routeWaypointId: waypoints[1]!.id,
          sequence: 2,
          plannedArrivalAt: at(2),
          plannedDepartureAt: at(1),
        },
      }),
    ).rejects.toThrow(/trip_waypoint_timing_dwell_order/);
  });

  it('refuses SCHEDULED without a complete, valid timetable', async () => {
    // Missing waypoint.
    const missing = await draftWithTimetable();
    await db(t.app).tripWaypointTiming.deleteMany({
      where: { tripId: missing.trip.id, sequence: 2 },
    });
    await expect(schedule(missing.trip.id)).rejects.toThrow(/cover exactly the waypoints/);

    // No timetable at all.
    const empty = await routeVersion();
    const bare = await db(t.app).trip.create({
      data: { reference: reference(), routeVersionId: empty.version.id },
    });
    await expect(
      db(t.app).trip.update({
        where: { id: bare.id },
        data: {
          status: 'SCHEDULED',
          scheduledAt: new Date(),
          plannedDepartureAt: at(0),
          plannedArrivalAt: at(4),
        },
      }),
    ).rejects.toThrow(/cover exactly the waypoints/);

    // Not chronological: the middle arrival before the first departure.
    const backwards = await draftWithTimetable();
    await db(t.app).tripWaypointTiming.update({
      where: { id: backwards.timings[1]!.id },
      data: { plannedArrivalAt: at(-1), plannedDepartureAt: at(-0.5) },
    });
    await expect(schedule(backwards.trip.id)).rejects.toThrow(/chronological/);

    // First waypoint with an arrival time.
    const firstArrival = await draftWithTimetable();
    await db(t.app).tripWaypointTiming.update({
      where: { id: firstArrival.timings[0]!.id },
      data: { plannedArrivalAt: at(-0.5) },
    });
    await expect(schedule(firstArrival.trip.id)).rejects.toThrow(
      /first waypoint has a departure time only/,
    );

    // Last waypoint with a departure time.
    const lastDeparture = await draftWithTimetable();
    await db(t.app).tripWaypointTiming.update({
      where: { id: lastDeparture.timings[2]!.id },
      data: { plannedDepartureAt: at(4.5) },
    });
    await expect(schedule(lastDeparture.trip.id)).rejects.toThrow(
      /last waypoint has an arrival time only/,
    );

    // Intermediate waypoint without a departure.
    const noDeparture = await draftWithTimetable();
    await db(t.app).tripWaypointTiming.update({
      where: { id: noDeparture.timings[1]!.id },
      data: { plannedDepartureAt: null },
    });
    await expect(schedule(noDeparture.trip.id)).rejects.toThrow(/intermediate waypoint/);

    // Trip times not matching the timetable.
    const mismatch = await draftWithTimetable();
    await db(t.app).trip.update({
      where: { id: mismatch.trip.id },
      data: { plannedDepartureAt: at(0.5), plannedArrivalAt: at(4) },
    });
    await expect(schedule(mismatch.trip.id)).rejects.toThrow(/trip departure must equal/);

    const valid = await draftWithTimetable();
    await expect(schedule(valid.trip.id)).resolves.toMatchObject({ status: 'SCHEDULED' });
  });

  it('freezes the timetable and planned times once the trip leaves DRAFT', async () => {
    const { trip, timings, waypoints } = await draftWithTimetable();
    await schedule(trip.id);
    await expect(
      db(t.app).tripWaypointTiming.update({
        where: { id: timings[1]!.id },
        data: { plannedArrivalAt: at(1.5) },
      }),
    ).rejects.toThrow(/timetable of a scheduled or cancelled trip is immutable/);
    await expect(
      db(t.app).tripWaypointTiming.delete({ where: { id: timings[1]!.id } }),
    ).rejects.toThrow(/timetable of a scheduled or cancelled trip is immutable/);
    await expect(
      db(t.app).tripWaypointTiming.create({
        data: {
          tripId: trip.id,
          routeWaypointId: waypoints[1]!.id,
          sequence: 2,
          plannedArrivalAt: at(1),
        },
      }),
    ).rejects.toThrow(/timetable of a scheduled or cancelled trip is immutable/);
    await expect(
      db(t.app).trip.update({ where: { id: trip.id }, data: { plannedArrivalAt: at(5) } }),
    ).rejects.toThrow(/timetable of a scheduled trip is frozen/);

    await cancel(trip.id);
    await expect(
      db(t.app).$executeRawUnsafe(
        `DELETE FROM "trip_waypoint_timing" WHERE "trip_id" = '${trip.id}'`,
      ),
    ).rejects.toThrow(/timetable of a scheduled or cancelled trip is immutable/);
    expect(await db(t.app).tripWaypointTiming.count({ where: { tripId: trip.id } })).toBe(3);
  });

  it('keeps existing trips valid when their route version is retired later', async () => {
    const { trip, version } = await draftWithTimetable();
    await schedule(trip.id);
    await db(t.app).routeVersion.update({
      where: { id: version.id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
    await expect(cancel(trip.id)).resolves.toMatchObject({ status: 'CANCELLED' });
    // A retired (historically published) version still accepts a new trip at
    // database level; the service decides whether planning on it is allowed.
    await expect(
      db(t.app).trip.create({ data: { reference: reference(), routeVersionId: version.id } }),
    ).resolves.toMatchObject({ status: 'DRAFT' });
  });

  it('requires an ACTIVE vehicle when assigning or scheduling, without blocking fleet changes', async () => {
    const { version } = await routeVersion();
    for (const status of ['PLANNED', 'OUT_OF_SERVICE', 'RETIRED'] as const) {
      const unavailable = await vehicle(status);
      await expect(
        db(t.app).trip.create({
          data: { reference: reference(), routeVersionId: version.id, vehicleId: unavailable.id },
        }),
      ).rejects.toThrow(/assigned vehicle must be ACTIVE/);
    }
    const active = await vehicle('ACTIVE');
    const { trip } = await draftWithTimetable(active.id);
    // The vehicle goes out of service after assignment: the fleet is not blocked...
    await expect(
      db(t.app).vehicle.update({ where: { id: active.id }, data: { status: 'OUT_OF_SERVICE' } }),
    ).resolves.toMatchObject({ status: 'OUT_OF_SERVICE' });
    // ...but the trip can no longer be scheduled with it.
    await expect(schedule(trip.id)).rejects.toThrow(/assigned vehicle must be ACTIVE/);
    await db(t.app).trip.update({ where: { id: trip.id }, data: { vehicleId: null } });
    await expect(schedule(trip.id)).resolves.toMatchObject({
      status: 'SCHEDULED',
      vehicleId: null,
    });
  });

  it('cannot be bypassed: no DELETE or TRUNCATE of trips and timetables', async () => {
    const { trip } = await draftWithTimetable();
    await expect(db(t.app).trip.delete({ where: { id: trip.id } })).rejects.toThrow(
      /trips cannot be deleted/,
    );
    await expect(db(t.app).$executeRawUnsafe('DELETE FROM "trip"')).rejects.toThrow(
      /trips cannot be deleted/,
    );
    await expect(
      db(t.app).$executeRawUnsafe('TRUNCATE TABLE "trip_waypoint_timing"'),
    ).rejects.toThrow(/trip history cannot be truncated/);
    await expect(db(t.app).$executeRawUnsafe('TRUNCATE TABLE "trip" CASCADE')).rejects.toThrow(
      /trip history cannot be truncated/,
    );
    await schedule(trip.id);
    await expect(
      db(t.app).$executeRawUnsafe(`DELETE FROM "trip" WHERE "id" = '${trip.id}'`),
    ).rejects.toThrow(/trips cannot be deleted/);
  });

  it('seeds the explicit trip permission matrix; managers can also read routes and vehicles', async () => {
    const grants = await db(t.app).authorizationRolePermission.findMany({
      where: { permissionKey: { in: ['trip.read', 'trip.manage'] } },
      orderBy: [{ permissionKey: 'asc' }, { roleKey: 'asc' }],
      select: { permissionKey: true, roleKey: true },
    });
    expect(grants.map((g) => `${g.permissionKey}:${g.roleKey}`)).toEqual([
      'trip.manage:DIRECTOR',
      'trip.manage:DISPATCHER',
      'trip.manage:OPS_MANAGER',
      'trip.manage:SUPER_ADMIN',
      'trip.read:AUDITOR',
      'trip.read:BOOKING_AGENT',
      'trip.read:COMPLIANCE_AGENT',
      'trip.read:CUSTOMER_SUPPORT',
      'trip.read:DIRECTOR',
      'trip.read:DISPATCHER',
      'trip.read:OPS_MANAGER',
      'trip.read:SUPER_ADMIN',
    ]);
    for (const { roleKey } of grants.filter((g) => g.permissionKey === 'trip.manage')) {
      const held = await db(t.app).authorizationRolePermission.findMany({
        where: { roleKey, permissionKey: { in: ['network.read', 'fleet.read'] } },
      });
      expect(held, roleKey).toHaveLength(2);
    }
  });
});
