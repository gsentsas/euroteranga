import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

type Kind = 'SEAT' | 'AISLE' | 'DRIVER' | 'DOOR' | 'TOILET' | 'STAIRS' | 'OTHER';

/**
 * Seat-map invariants proven through direct database writes (Prisma and raw
 * SQL), including the vehicle and trip rules added by PR-07. Synthetic data.
 */
describe('seat map database invariants (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    countryId = (
      await db(t.app).country.create({ data: { iso2: 'QS', iso3: 'QSS', name: 'Pays S' } })
    ).id;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const suffix = () => randomBytes(4).toString('hex').toUpperCase();

  const seatMap = (data: Record<string, unknown> = {}) =>
    db(t.app).seatMap.create({
      data: { code: `SM_${suffix()}`, name: 'Plan synthétique', ...data },
    });

  const cell = (
    seatMapVersionId: string,
    deck: number,
    row: number,
    column: number,
    kind: Kind,
    seatLabel: string | null = null,
  ) =>
    db(t.app).seatMapCell.create({
      data: { seatMapVersionId, deck, row, column, kind, seatLabel },
    });

  const publish = (id: string) =>
    db(t.app).seatMapVersion.update({
      where: { id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
  const retire = (id: string) =>
    db(t.app).seatMapVersion.update({
      where: { id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });

  /** A DRAFT version with DRIVER + 2 seats + AISLE, optionally published. */
  async function version(state: 'DRAFT' | 'PUBLISHED' = 'PUBLISHED', parent?: string) {
    const map = parent ?? (await seatMap()).id;
    const last = await db(t.app).seatMapVersion.findFirst({
      where: { seatMapId: map },
      orderBy: { version: 'desc' },
    });
    const created = await db(t.app).seatMapVersion.create({
      data: { seatMapId: map, version: (last?.version ?? 0) + 1 },
    });
    await cell(created.id, 1, 1, 1, 'DRIVER');
    await cell(created.id, 1, 2, 1, 'SEAT', '1A');
    await cell(created.id, 1, 2, 2, 'AISLE');
    await cell(created.id, 1, 2, 3, 'SEAT', '1B');
    if (state === 'PUBLISHED') await publish(created.id);
    return created;
  }

  async function activeVehicle(seatMapVersionId?: string) {
    const created = await db(t.app).vehicle.create({
      data: { code: `VH_${suffix()}`, manufacturer: 'Constructeur', model: 'Modèle' },
    });
    await db(t.app).vehicle.update({ where: { id: created.id }, data: { status: 'ACTIVE' } });
    if (seatMapVersionId) {
      await db(t.app).vehicle.update({ where: { id: created.id }, data: { seatMapVersionId } });
    }
    return created;
  }

  /** A DRAFT trip with a complete timetable on a 2-stop published route. */
  async function draftTrip(vehicleId?: string) {
    const stop = (code: string) =>
      db(t.app).stop.create({
        data: {
          code,
          name: code,
          countryId,
          locality: 'L',
          latitude: 1,
          longitude: 1,
          timezone: 'Etc/UTC',
        },
      });
    const [a, b] = [await stop(`S_${suffix()}`), await stop(`S_${suffix()}`)];
    const route = await db(t.app).route.create({ data: { code: `R_${suffix()}`, name: 'Route' } });
    const routeVersion = await db(t.app).routeVersion.create({
      data: { routeId: route.id, version: 1 },
    });
    await db(t.app).routeWaypoint.createMany({
      data: [
        { routeVersionId: routeVersion.id, sequence: 1, stopId: a.id },
        { routeVersionId: routeVersion.id, sequence: 2, stopId: b.id },
      ],
    });
    await db(t.app).routeVersion.update({
      where: { id: routeVersion.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    const waypoints = await db(t.app).routeWaypoint.findMany({
      where: { routeVersionId: routeVersion.id },
      orderBy: { sequence: 'asc' },
    });
    const trip = await db(t.app).trip.create({
      data: {
        reference: `ET-TEST-2030-${suffix()}`,
        routeVersionId: routeVersion.id,
        ...(vehicleId ? { vehicleId } : {}),
      },
    });
    const departure = new Date('2030-01-15T08:00:00Z');
    const arrival = new Date('2030-01-15T12:00:00Z');
    await db(t.app).tripWaypointTiming.createMany({
      data: [
        {
          tripId: trip.id,
          routeWaypointId: waypoints[0]!.id,
          sequence: 1,
          plannedDepartureAt: departure,
        },
        {
          tripId: trip.id,
          routeWaypointId: waypoints[1]!.id,
          sequence: 2,
          plannedArrivalAt: arrival,
        },
      ],
    });
    return db(t.app).trip.update({
      where: { id: trip.id },
      data: { plannedDepartureAt: departure, plannedArrivalAt: arrival },
    });
  }

  const schedule = (id: string) =>
    db(t.app).trip.update({
      where: { id },
      data: { status: 'SCHEDULED', scheduledAt: new Date() },
    });

  describe('seat maps and versions', () => {
    it('requires a unique, normalized seat map code', async () => {
      await seatMap({ code: 'COACH_TEST_A' });
      await expect(seatMap({ code: 'COACH_TEST_A' })).rejects.toThrow();
      await expect(seatMap({ code: 'coach_test_b' })).rejects.toThrow(/seat_map_code_normalized/);
      await expect(seatMap({ name: ' Padded' })).rejects.toThrow(/seat_map_name_normalized/);
    });

    it('allows one DRAFT and one PUBLISHED per seat map, unique version numbers', async () => {
      const map = await seatMap();
      const first = await db(t.app).seatMapVersion.create({
        data: { seatMapId: map.id, version: 1 },
      });
      await expect(
        db(t.app).seatMapVersion.create({ data: { seatMapId: map.id, version: 2 } }),
      ).rejects.toThrow();
      await cell(first.id, 1, 1, 1, 'SEAT', '1A');
      await publish(first.id);
      await expect(
        db(t.app).seatMapVersion.create({ data: { seatMapId: map.id, version: 1 } }),
      ).rejects.toThrow();
      const second = await db(t.app).seatMapVersion.create({
        data: { seatMapId: map.id, version: 2 },
      });
      await cell(second.id, 1, 1, 1, 'SEAT', '1A');
      // Two PUBLISHED at once are refused by the partial unique index.
      await expect(publish(second.id)).rejects.toThrow();
      await retire(first.id);
      await expect(publish(second.id)).resolves.toMatchObject({ status: 'PUBLISHED' });
    });

    it('creates DRAFT only and follows DRAFT -> PUBLISHED -> RETIRED', async () => {
      const map = await seatMap();
      await expect(
        db(t.app).seatMapVersion.create({
          data: { seatMapId: map.id, version: 1, status: 'PUBLISHED', publishedAt: new Date() },
        }),
      ).rejects.toThrow(/must be created as DRAFT/);
      await expect(
        db(t.app).seatMapVersion.create({ data: { seatMapId: map.id, version: 0 } }),
      ).rejects.toThrow(/seat_map_version_number_positive/);
      const draft = await db(t.app).seatMapVersion.create({
        data: { seatMapId: map.id, version: 1 },
      });
      await expect(retire(draft.id)).rejects.toThrow(
        /draft seat map version may only transition to PUBLISHED/,
      );
      await expect(
        db(t.app).seatMapVersion.update({
          where: { id: draft.id },
          data: { publishedAt: new Date() },
        }),
      ).rejects.toThrow(/seat_map_version_status_timestamps/);
    });

    it('publishes only with at least one SEAT and an active seat map', async () => {
      const map = await seatMap();
      const noSeat = await db(t.app).seatMapVersion.create({
        data: { seatMapId: map.id, version: 1 },
      });
      await cell(noSeat.id, 1, 1, 1, 'DRIVER');
      await cell(noSeat.id, 1, 1, 2, 'DOOR');
      await expect(publish(noSeat.id)).rejects.toThrow(/at least one SEAT/);
      await cell(noSeat.id, 1, 2, 1, 'SEAT', '1A');
      await db(t.app).seatMap.update({ where: { id: map.id }, data: { active: false } });
      await expect(publish(noSeat.id)).rejects.toThrow(/inactive seat map/);
      await db(t.app).seatMap.update({ where: { id: map.id }, data: { active: true } });
      await expect(publish(noSeat.id)).resolves.toMatchObject({ status: 'PUBLISHED' });
    });

    it('keeps published and retired versions historical and immutable', async () => {
      const published = await version();
      await expect(
        db(t.app).seatMapVersion.update({ where: { id: published.id }, data: { version: 9 } }),
      ).rejects.toThrow(/identity is immutable/);
      await expect(
        db(t.app).seatMapVersion.update({
          where: { id: published.id },
          data: { publishedAt: new Date(0) },
        }),
      ).rejects.toThrow(/may only transition to RETIRED/);
      await expect(
        db(t.app).seatMapVersion.delete({ where: { id: published.id } }),
      ).rejects.toThrow(/published or retired seat map versions are immutable/);
      await retire(published.id);
      await expect(
        db(t.app).$executeRawUnsafe(
          `UPDATE "seat_map_version" SET "status" = 'PUBLISHED', "retired_at" = NULL WHERE "id" = '${published.id}'`,
        ),
      ).rejects.toThrow(/retired seat map versions are immutable/);
      await expect(
        db(t.app).$executeRawUnsafe(
          `DELETE FROM "seat_map_version" WHERE "id" = '${published.id}'`,
        ),
      ).rejects.toThrow(/published or retired seat map versions are immutable/);
    });
  });

  describe('cells', () => {
    it('bounds coordinates and keeps positions and labels unique per version', async () => {
      const draft = await version('DRAFT');
      for (const [deck, row, column] of [
        [0, 1, 1],
        [5, 1, 1],
        [1, 0, 1],
        [1, 101, 1],
        [1, 1, 0],
        [1, 1, 21],
      ] as const) {
        await expect(
          cell(draft.id, deck, row, column, 'AISLE'),
          `${deck}/${row}/${column}`,
        ).rejects.toThrow(/seat_map_cell_coordinates_range/);
      }
      await expect(cell(draft.id, 4, 100, 20, 'OTHER')).resolves.toBeDefined();
      await expect(cell(draft.id, 1, 2, 1, 'AISLE')).rejects.toThrow(); // position taken by 1A
      await expect(cell(draft.id, 1, 3, 1, 'SEAT', '1A')).rejects.toThrow(); // label taken
      // Same position and label in another (empty) version are independent.
      const empty = await db(t.app).seatMapVersion.create({
        data: { seatMapId: (await seatMap()).id, version: 1 },
      });
      await expect(cell(empty.id, 1, 2, 1, 'SEAT', '1A')).resolves.toBeDefined();
    });

    it('requires a label for SEAT only, normalized', async () => {
      const draft = await version('DRAFT');
      await expect(cell(draft.id, 1, 5, 1, 'SEAT')).rejects.toThrow(
        /seat_map_cell_label_for_seats/,
      );
      await expect(cell(draft.id, 1, 5, 1, 'AISLE', 'X1')).rejects.toThrow(
        /seat_map_cell_label_for_seats/,
      );
      await expect(cell(draft.id, 1, 5, 1, 'SEAT', '5a')).rejects.toThrow(
        /seat_map_cell_label_normalized/,
      );
      await expect(cell(draft.id, 1, 5, 1, 'SEAT', ' 5A')).rejects.toThrow(
        /seat_map_cell_label_normalized/,
      );
      await expect(cell(draft.id, 1, 5, 1, 'SEAT', 'ABCDEFGHI')).rejects.toThrow();
      await expect(cell(draft.id, 1, 5, 1, 'SEAT', '12C')).resolves.toMatchObject({
        seatLabel: '12C',
      });
    });

    it('refuses cell writes outside DRAFT, including raw SQL, DELETE and TRUNCATE', async () => {
      const published = await version();
      const existing = await db(t.app).seatMapCell.findFirstOrThrow({
        where: { seatMapVersionId: published.id, kind: 'SEAT' },
      });
      await expect(cell(published.id, 1, 9, 1, 'SEAT', '9A')).rejects.toThrow(
        /cells of published or retired seat map versions are immutable/,
      );
      await expect(
        db(t.app).seatMapCell.update({ where: { id: existing.id }, data: { seatLabel: '9Z' } }),
      ).rejects.toThrow(/immutable/);
      await expect(db(t.app).seatMapCell.delete({ where: { id: existing.id } })).rejects.toThrow(
        /immutable/,
      );
      await expect(
        db(t.app).$executeRawUnsafe(
          `DELETE FROM "seat_map_cell" WHERE "seat_map_version_id" = '${published.id}'`,
        ),
      ).rejects.toThrow(/cells of published or retired seat map versions are immutable/);
      const draft = await version('DRAFT');
      const draftCell = await db(t.app).seatMapCell.findFirstOrThrow({
        where: { seatMapVersionId: draft.id },
      });
      await expect(
        db(t.app).seatMapCell.update({
          where: { id: draftCell.id },
          data: { seatMapVersionId: published.id },
        }),
      ).rejects.toThrow(/identity and version are immutable/);
      await expect(db(t.app).$executeRawUnsafe('TRUNCATE TABLE "seat_map_cell"')).rejects.toThrow(
        /seat map history cannot be truncated/,
      );
      // seat_map_version is referenced by cells, vehicles and trips: a plain
      // TRUNCATE stops at the foreign key, a CASCADE reaches its trigger.
      await expect(
        db(t.app).$executeRawUnsafe('TRUNCATE TABLE "seat_map_version"'),
      ).rejects.toThrow(/referenced in a foreign key constraint/);
      await expect(
        db(t.app).$executeRawUnsafe('TRUNCATE TABLE "seat_map_version" CASCADE'),
      ).rejects.toThrow(/seat map history cannot be truncated/);
      expect(await db(t.app).seatMapCell.count({ where: { seatMapVersionId: published.id } })).toBe(
        4,
      );
    });
  });

  describe('vehicles', () => {
    it('accepts only versions that have been published; retirement does not break the link', async () => {
      const draft = await version('DRAFT');
      const vehicle = await activeVehicle();
      await expect(
        db(t.app).vehicle.update({
          where: { id: vehicle.id },
          data: { seatMapVersionId: draft.id },
        }),
      ).rejects.toThrow(/vehicle seat map must be a version that has been published/);
      await expect(
        db(t.app).$executeRawUnsafe(
          `UPDATE "vehicle" SET "seat_map_version_id" = '${draft.id}' WHERE "id" = '${vehicle.id}'`,
        ),
      ).rejects.toThrow(/has been published/);

      const published = await version();
      await expect(
        db(t.app).vehicle.update({
          where: { id: vehicle.id },
          data: { seatMapVersionId: published.id },
        }),
      ).resolves.toMatchObject({ seatMapVersionId: published.id });
      await retire(published.id);
      // The vehicle keeps its version and stays editable.
      await expect(
        db(t.app).vehicle.update({ where: { id: vehicle.id }, data: { model: 'Modèle révisé' } }),
      ).resolves.toMatchObject({ seatMapVersionId: published.id, model: 'Modèle révisé' });
      // A retired (historically published) version is still accepted at
      // database level; the service requires a currently PUBLISHED one.
      const other = await activeVehicle();
      await expect(
        db(t.app).vehicle.update({
          where: { id: other.id },
          data: { seatMapVersionId: published.id },
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('trips', () => {
    it('changes the seat map only while DRAFT, only to published versions', async () => {
      const trip = await draftTrip();
      const draft = await version('DRAFT');
      await expect(
        db(t.app).trip.update({ where: { id: trip.id }, data: { seatMapVersionId: draft.id } }),
      ).rejects.toThrow(/trip seat map must be a version that has been published/);
      const [first, second] = [await version(), await version()];
      await db(t.app).trip.update({ where: { id: trip.id }, data: { seatMapVersionId: first.id } });
      await schedule(trip.id);
      await expect(
        db(t.app).trip.update({ where: { id: trip.id }, data: { seatMapVersionId: second.id } }),
      ).rejects.toThrow(/seat map of a scheduled or cancelled trip is frozen/);
      await expect(
        db(t.app).trip.update({
          where: { id: trip.id },
          data: { status: 'CANCELLED', cancelledAt: new Date(), seatMapVersionId: null },
        }),
      ).rejects.toThrow(/frozen/);

      // Changing the seat map while scheduling is refused as well.
      const other = await draftTrip();
      await expect(
        db(t.app).trip.update({
          where: { id: other.id },
          data: { status: 'SCHEDULED', scheduledAt: new Date(), seatMapVersionId: first.id },
        }),
      ).rejects.toThrow(/frozen/);
    });

    it('requires the vehicle and trip seat maps to match when either changes or when scheduling', async () => {
      const [layout, otherLayout] = [await version(), await version()];
      const matching = await activeVehicle(layout.id);
      const different = await activeVehicle(otherLayout.id);
      const bare = await activeVehicle();

      // Seat map first, then vehicles.
      const trip = await draftTrip();
      await db(t.app).trip.update({
        where: { id: trip.id },
        data: { seatMapVersionId: layout.id },
      });
      for (const vehicle of [different, bare]) {
        await expect(
          db(t.app).trip.update({ where: { id: trip.id }, data: { vehicleId: vehicle.id } }),
        ).rejects.toThrow(/incompatible/);
      }
      await expect(
        db(t.app).trip.update({ where: { id: trip.id }, data: { vehicleId: matching.id } }),
      ).resolves.toMatchObject({ vehicleId: matching.id });

      // Vehicle first, then seat maps.
      const second = await draftTrip(bare.id);
      await expect(
        db(t.app).trip.update({ where: { id: second.id }, data: { seatMapVersionId: layout.id } }),
      ).rejects.toThrow(/incompatible/);

      // The vehicle changes its configuration while the trip is DRAFT: the
      // trip is not touched, but it can no longer be scheduled as is.
      await db(t.app).vehicle.update({
        where: { id: matching.id },
        data: { seatMapVersionId: otherLayout.id },
      });
      await expect(schedule(trip.id)).rejects.toThrow(/incompatible/);
      await db(t.app).vehicle.update({
        where: { id: matching.id },
        data: { seatMapVersionId: layout.id },
      });
      await expect(schedule(trip.id)).resolves.toMatchObject({
        status: 'SCHEDULED',
        seatMapVersionId: layout.id,
      });
    });

    it('keeps historical trips untouched by later vehicle or seat map changes', async () => {
      const [layout, next] = [await version(), await version()];
      const vehicle = await activeVehicle(layout.id);
      const trip = await draftTrip(vehicle.id);
      await db(t.app).trip.update({
        where: { id: trip.id },
        data: { seatMapVersionId: layout.id },
      });
      await schedule(trip.id);
      // Fleet is not blocked: the vehicle gets another layout...
      await expect(
        db(t.app).vehicle.update({
          where: { id: vehicle.id },
          data: { seatMapVersionId: next.id },
        }),
      ).resolves.toMatchObject({ seatMapVersionId: next.id });
      // ...and the trip's version is retired: the trip keeps both references.
      await retire(layout.id);
      expect(await db(t.app).trip.findUniqueOrThrow({ where: { id: trip.id } })).toMatchObject({
        status: 'SCHEDULED',
        vehicleId: vehicle.id,
        seatMapVersionId: layout.id,
      });
      await expect(
        db(t.app).trip.update({
          where: { id: trip.id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        }),
      ).resolves.toMatchObject({ status: 'CANCELLED', seatMapVersionId: layout.id });
    });

    it('lets PR-06 trips without a seat map be scheduled', async () => {
      const vehicle = await activeVehicle();
      const trip = await draftTrip(vehicle.id);
      await expect(schedule(trip.id)).resolves.toMatchObject({
        status: 'SCHEDULED',
        seatMapVersionId: null,
      });
    });
  });

  it('seeds the explicit seat map permission matrix; fleet and trip managers can read seat maps', async () => {
    const grants = await db(t.app).authorizationRolePermission.findMany({
      where: { permissionKey: { in: ['seatmap.read', 'seatmap.manage'] } },
      orderBy: [{ permissionKey: 'asc' }, { roleKey: 'asc' }],
      select: { permissionKey: true, roleKey: true },
    });
    expect(grants.map((g) => `${g.permissionKey}:${g.roleKey}`)).toEqual([
      'seatmap.manage:DIRECTOR',
      'seatmap.manage:OPS_MANAGER',
      'seatmap.manage:SUPER_ADMIN',
      'seatmap.read:AUDITOR',
      'seatmap.read:BOOKING_AGENT',
      'seatmap.read:COMPLIANCE_AGENT',
      'seatmap.read:CUSTOMER_SUPPORT',
      'seatmap.read:DIRECTOR',
      'seatmap.read:DISPATCHER',
      'seatmap.read:OPS_MANAGER',
      'seatmap.read:SUPER_ADMIN',
    ]);
    const managers = await db(t.app).authorizationRolePermission.findMany({
      where: { permissionKey: { in: ['fleet.manage', 'trip.manage'] } },
      select: { roleKey: true },
      distinct: ['roleKey'],
    });
    expect(managers.length).toBeGreaterThan(0);
    for (const { roleKey } of managers) {
      expect(
        await db(t.app).authorizationRolePermission.count({
          where: { roleKey, permissionKey: 'seatmap.read' },
        }),
        roleKey,
      ).toBe(1);
    }
  });
});
