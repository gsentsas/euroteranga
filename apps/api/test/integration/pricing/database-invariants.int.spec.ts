import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * Pricing invariants proven through direct database writes (Prisma and raw
 * SQL), including the trip rules added by PR-08. Synthetic data only.
 */
describe('pricing database invariants (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    countryId = (
      await db(t.app).country.create({ data: { iso2: 'QP', iso3: 'QPP', name: 'Pays P' } })
    ).id;
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const suffix = () => randomBytes(4).toString('hex').toUpperCase();

  /**
   * Route A(board) -> C(checkpoint) -> B(board+alight) -> D(alight) and its
   * version, published unless asked otherwise.
   */
  async function route(publish = true) {
    const stop = () =>
      db(t.app).stop.create({
        data: {
          code: `S_${suffix()}`,
          name: 'Arrêt',
          countryId,
          locality: 'L',
          latitude: 1,
          longitude: 1,
          timezone: 'Etc/UTC',
        },
      });
    const [a, b, d] = [await stop(), await stop(), await stop()];
    const c = await db(t.app).checkpoint.create({
      data: {
        code: `C_${suffix()}`,
        name: 'CP',
        countryId,
        type: 'TECHNICAL',
        locality: 'L',
        latitude: 1,
        longitude: 1,
        timezone: 'Etc/UTC',
      },
    });
    const commercial = await db(t.app).route.create({
      data: { code: `R_${suffix()}`, name: 'Route' },
    });
    const version = await db(t.app).routeVersion.create({
      data: { routeId: commercial.id, version: 1 },
    });
    await db(t.app).routeWaypoint.createMany({
      data: [
        { routeVersionId: version.id, sequence: 1, stopId: a.id, boardingAllowed: true },
        { routeVersionId: version.id, sequence: 2, checkpointId: c.id },
        {
          routeVersionId: version.id,
          sequence: 3,
          stopId: b.id,
          boardingAllowed: true,
          alightingAllowed: true,
        },
        { routeVersionId: version.id, sequence: 4, stopId: d.id, alightingAllowed: true },
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
    const [A, C, B, D] = waypoints;
    return { routeId: commercial.id, routeVersionId: version.id, A: A!, C: C!, B: B!, D: D! };
  }

  const fareTable = (routeId: string, data: Record<string, unknown> = {}) =>
    db(t.app).fareTable.create({
      data: {
        code: `FT_${suffix()}`,
        name: 'Tarif synthétique',
        routeId,
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        ...data,
      },
    });

  const publish = (id: string) =>
    db(t.app).fareTableVersion.update({
      where: { id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
  const retire = (id: string) =>
    db(t.app).fareTableVersion.update({
      where: { id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
  const entry = (
    fareTableVersionId: string,
    originRouteWaypointId: string,
    destinationRouteWaypointId: string,
    amountMinor = 12550,
  ) =>
    db(t.app).fareEntry.create({
      data: { fareTableVersionId, originRouteWaypointId, destinationRouteWaypointId, amountMinor },
    });

  /** A fare table version with A->B and A->D, published unless asked otherwise. */
  async function pricedVersion(
    state: 'DRAFT' | 'PUBLISHED' = 'PUBLISHED',
    r?: Awaited<ReturnType<typeof route>>,
  ) {
    const geo = r ?? (await route());
    const table = await fareTable(geo.routeId);
    const version = await db(t.app).fareTableVersion.create({
      data: { fareTableId: table.id, routeVersionId: geo.routeVersionId, version: 1 },
    });
    await entry(version.id, geo.A.id, geo.B.id, 12550);
    await entry(version.id, geo.A.id, geo.D.id, 20000);
    if (state === 'PUBLISHED') await publish(version.id);
    return { geo, table, version };
  }

  /** A DRAFT trip with a complete timetable on the given published route. */
  async function draftTrip(geo: Awaited<ReturnType<typeof route>>) {
    const trip = await db(t.app).trip.create({
      data: { reference: `ET-TEST-2030-${suffix()}`, routeVersionId: geo.routeVersionId },
    });
    const base = Date.UTC(2030, 4, 1, 8);
    const at = (hours: number) => new Date(base + hours * 3_600_000);
    await db(t.app).tripWaypointTiming.createMany({
      data: [
        { tripId: trip.id, routeWaypointId: geo.A.id, sequence: 1, plannedDepartureAt: at(0) },
        {
          tripId: trip.id,
          routeWaypointId: geo.C.id,
          sequence: 2,
          plannedArrivalAt: at(1),
          plannedDepartureAt: at(1),
        },
        {
          tripId: trip.id,
          routeWaypointId: geo.B.id,
          sequence: 3,
          plannedArrivalAt: at(2),
          plannedDepartureAt: at(2.5),
        },
        { tripId: trip.id, routeWaypointId: geo.D.id, sequence: 4, plannedArrivalAt: at(4) },
      ],
    });
    return db(t.app).trip.update({
      where: { id: trip.id },
      data: { plannedDepartureAt: at(0), plannedArrivalAt: at(4) },
    });
  }

  const schedule = (id: string) =>
    db(t.app).trip.update({
      where: { id },
      data: { status: 'SCHEDULED', scheduledAt: new Date() },
    });

  describe('fare tables', () => {
    it('normalizes code and currency, bounds the minor unit, requires a route', async () => {
      const geo = await route();
      await fareTable(geo.routeId, { code: 'PAR_DKR_TEST' });
      await expect(fareTable(geo.routeId, { code: 'PAR_DKR_TEST' })).rejects.toThrow();
      await expect(fareTable(geo.routeId, { code: 'par_dkr_test2' })).rejects.toThrow(
        /fare_table_code_normalized/,
      );
      for (const currencyCode of ['eur', 'EU', 'EURO', 'E1R', ' EUR']) {
        await expect(fareTable(geo.routeId, { currencyCode }), currencyCode).rejects.toThrow();
      }
      await expect(fareTable(geo.routeId, { currencyMinorUnit: 4 })).rejects.toThrow(
        /fare_table_currency_minor_unit_range/,
      );
      await expect(fareTable(geo.routeId, { currencyMinorUnit: -1 })).rejects.toThrow(
        /fare_table_currency_minor_unit_range/,
      );
      await expect(
        fareTable(geo.routeId, { currencyCode: 'XOF', currencyMinorUnit: 0 }),
      ).resolves.toBeDefined();
      await expect(fareTable('01900000-0000-7000-8000-000000000000')).rejects.toThrow();
    });

    it('keeps route and currency immutable (the meaning of every amount)', async () => {
      const geo = await route();
      const other = await route();
      const table = await fareTable(geo.routeId);
      for (const data of [
        { currencyCode: 'XOF' },
        { currencyMinorUnit: 0 },
        { routeId: other.routeId },
      ]) {
        await expect(
          db(t.app).fareTable.update({ where: { id: table.id }, data }),
          JSON.stringify(data),
        ).rejects.toThrow(/route and currency are immutable/);
      }
      await expect(
        db(t.app).$executeRawUnsafe(
          `UPDATE "fare_table" SET "currency_minor_unit" = 3 WHERE "id" = '${table.id}'`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        db(t.app).fareTable.update({
          where: { id: table.id },
          data: { name: 'Renommé', active: false },
        }),
      ).resolves.toMatchObject({ name: 'Renommé', active: false });
    });
  });

  describe('versions', () => {
    it('needs a published route version of the fare table route', async () => {
      const geo = await route();
      const draftRoute = await route(false);
      const foreign = await route();
      const table = await fareTable(geo.routeId);
      await expect(
        db(t.app).fareTableVersion.create({
          data: { fareTableId: table.id, routeVersionId: foreign.routeVersionId, version: 1 },
        }),
      ).rejects.toThrow(/route version of the fare table route/);
      const tableOnDraftRoute = await fareTable(draftRoute.routeId);
      await expect(
        db(t.app).fareTableVersion.create({
          data: {
            fareTableId: tableOnDraftRoute.id,
            routeVersionId: draftRoute.routeVersionId,
            version: 1,
          },
        }),
      ).rejects.toThrow(/route version that has been published/);
      await expect(
        db(t.app).fareTableVersion.create({
          data: {
            fareTableId: table.id,
            routeVersionId: geo.routeVersionId,
            version: 1,
            status: 'PUBLISHED',
            publishedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/must be created as DRAFT/);
      await expect(
        db(t.app).fareTableVersion.create({
          data: { fareTableId: table.id, routeVersionId: geo.routeVersionId, version: 0 },
        }),
      ).rejects.toThrow(/fare_table_version_number_positive/);
    });

    it('allows one DRAFT and one PUBLISHED per fare table, unique numbers', async () => {
      const { geo, table, version } = await pricedVersion();
      await expect(
        db(t.app).fareTableVersion.create({
          data: { fareTableId: table.id, routeVersionId: geo.routeVersionId, version: 1 },
        }),
      ).rejects.toThrow();
      const second = await db(t.app).fareTableVersion.create({
        data: { fareTableId: table.id, routeVersionId: geo.routeVersionId, version: 2 },
      });
      await expect(
        db(t.app).fareTableVersion.create({
          data: { fareTableId: table.id, routeVersionId: geo.routeVersionId, version: 3 },
        }),
      ).rejects.toThrow();
      await entry(second.id, geo.A.id, geo.B.id, 13000);
      await expect(publish(second.id)).rejects.toThrow(); // two PUBLISHED
      await retire(version.id);
      await expect(publish(second.id)).resolves.toMatchObject({ status: 'PUBLISHED' });
    });

    it('publishes only an active table with at least one fare; lifecycle and history are protected', async () => {
      const geo = await route();
      const table = await fareTable(geo.routeId);
      const draft = await db(t.app).fareTableVersion.create({
        data: { fareTableId: table.id, routeVersionId: geo.routeVersionId, version: 1 },
      });
      await expect(publish(draft.id)).rejects.toThrow(/at least one fare/);
      await entry(draft.id, geo.A.id, geo.B.id);
      await db(t.app).fareTable.update({ where: { id: table.id }, data: { active: false } });
      await expect(publish(draft.id)).rejects.toThrow(/inactive fare table/);
      await db(t.app).fareTable.update({ where: { id: table.id }, data: { active: true } });
      await expect(retire(draft.id)).rejects.toThrow(
        /draft fare table version may only transition to PUBLISHED/,
      );
      await publish(draft.id);
      await expect(
        db(t.app).fareTableVersion.update({ where: { id: draft.id }, data: { version: 7 } }),
      ).rejects.toThrow(/identity is immutable/);
      await expect(
        db(t.app).fareTableVersion.update({
          where: { id: draft.id },
          data: { publishedAt: new Date(0) },
        }),
      ).rejects.toThrow(/may only transition to RETIRED/);
      await expect(
        db(t.app).$executeRawUnsafe(
          `UPDATE "fare_table_version" SET "status" = 'DRAFT', "published_at" = NULL WHERE "id" = '${draft.id}'`,
        ),
      ).rejects.toThrow(/may only transition to RETIRED/);
      await expect(db(t.app).fareTableVersion.delete({ where: { id: draft.id } })).rejects.toThrow(
        /immutable/,
      );
      await retire(draft.id);
      await expect(
        db(t.app).$executeRawUnsafe(
          `UPDATE "fare_table_version" SET "status" = 'PUBLISHED', "retired_at" = NULL WHERE "id" = '${draft.id}'`,
        ),
      ).rejects.toThrow(/retired fare table versions are immutable/);
      await expect(
        db(t.app).fareTableVersion.update({ where: { id: draft.id }, data: { retiredAt: null } }),
      ).rejects.toThrow();
    });
  });

  describe('fare entries', () => {
    it('requires a positive amount and a unique origin/destination pair', async () => {
      const { geo, version } = await pricedVersion('DRAFT');
      await expect(entry(version.id, geo.B.id, geo.D.id, 0)).rejects.toThrow(
        /fare_entry_amount_positive/,
      );
      await expect(entry(version.id, geo.B.id, geo.D.id, -5)).rejects.toThrow(
        /fare_entry_amount_positive/,
      );
      await expect(entry(version.id, geo.A.id, geo.B.id, 999)).rejects.toThrow(); // pair exists
      await expect(entry(version.id, geo.B.id, geo.D.id, 7500)).resolves.toMatchObject({
        amountMinor: 7500,
      });
    });

    it('accepts only stop waypoints of the version route, boarding then later alighting', async () => {
      const { geo, version } = await pricedVersion('DRAFT');
      const other = await route();
      await expect(entry(version.id, other.A.id, geo.D.id)).rejects.toThrow(
        /must belong to the fare table version route version/,
      );
      await expect(entry(version.id, geo.A.id, other.D.id)).rejects.toThrow(/must belong/);
      await expect(entry(version.id, geo.A.id, geo.C.id)).rejects.toThrow(/between stops only/);
      await expect(entry(version.id, geo.C.id, geo.D.id)).rejects.toThrow(/between stops only/);
      await expect(entry(version.id, geo.D.id, geo.B.id)).rejects.toThrow(
        /origin must allow boarding/,
      ); // D: alight only
      await expect(entry(version.id, geo.B.id, geo.A.id)).rejects.toThrow(
        /destination must allow alighting/,
      ); // A: board only
      // The same waypoint as origin and destination is refused (CHECK; the
      // trigger's order rule would refuse it as well).
      await expect(entry(version.id, geo.B.id, geo.B.id)).rejects.toThrow(
        /fare_entry_distinct_waypoints|before the destination/,
      );
      expect(
        await db(t.app).$queryRaw<Array<{ conname: string }>>`
          SELECT conname FROM pg_constraint WHERE conrelid = 'fare_entry'::regclass AND contype = 'c' ORDER BY conname
        `,
      ).toEqual([
        { conname: 'fare_entry_amount_positive' },
        { conname: 'fare_entry_distinct_waypoints' },
      ]);
    });

    it('enforces origin before destination even when both flags allow it', async () => {
      const stop = () =>
        db(t.app).stop.create({
          data: {
            code: `S_${suffix()}`,
            name: 'Arrêt',
            countryId,
            locality: 'L',
            latitude: 1,
            longitude: 1,
            timezone: 'Etc/UTC',
          },
        });
      const [x, y] = [await stop(), await stop()];
      const commercial = await db(t.app).route.create({
        data: { code: `R_${suffix()}`, name: 'Route' },
      });
      const version = await db(t.app).routeVersion.create({
        data: { routeId: commercial.id, version: 1 },
      });
      await db(t.app).routeWaypoint.createMany({
        data: [
          {
            routeVersionId: version.id,
            sequence: 1,
            stopId: x.id,
            boardingAllowed: true,
            alightingAllowed: true,
          },
          {
            routeVersionId: version.id,
            sequence: 2,
            stopId: y.id,
            boardingAllowed: true,
            alightingAllowed: true,
          },
        ],
      });
      await db(t.app).routeVersion.update({
        where: { id: version.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      const [X, Y] = await db(t.app).routeWaypoint.findMany({
        where: { routeVersionId: version.id },
        orderBy: { sequence: 'asc' },
      });
      const table = await fareTable(commercial.id);
      const v = await db(t.app).fareTableVersion.create({
        data: { fareTableId: table.id, routeVersionId: version.id, version: 1 },
      });
      await expect(entry(v.id, Y!.id, X!.id)).rejects.toThrow(
        /origin must come before the destination/,
      );
      await expect(entry(v.id, X!.id, Y!.id)).resolves.toBeDefined();
    });

    it('freezes fares once published, including raw SQL, DELETE and TRUNCATE', async () => {
      const { geo, version } = await pricedVersion();
      const existing = await db(t.app).fareEntry.findFirstOrThrow({
        where: { fareTableVersionId: version.id },
      });
      await expect(entry(version.id, geo.B.id, geo.D.id)).rejects.toThrow(
        /fares of published or retired fare table versions are immutable/,
      );
      await expect(
        db(t.app).fareEntry.update({ where: { id: existing.id }, data: { amountMinor: 1 } }),
      ).rejects.toThrow(/immutable/);
      await expect(db(t.app).fareEntry.delete({ where: { id: existing.id } })).rejects.toThrow(
        /immutable/,
      );
      await expect(
        db(t.app).$executeRawUnsafe(
          `UPDATE "fare_entry" SET "amount_minor" = 1 WHERE "fare_table_version_id" = '${version.id}'`,
        ),
      ).rejects.toThrow(/immutable/);
      const draft = await pricedVersion('DRAFT');
      const draftEntry = await db(t.app).fareEntry.findFirstOrThrow({
        where: { fareTableVersionId: draft.version.id },
      });
      await expect(
        db(t.app).fareEntry.update({
          where: { id: draftEntry.id },
          data: { fareTableVersionId: version.id },
        }),
      ).rejects.toThrow(/identity and version are immutable/);
      // Since PR-09, bookings reference fare entries: a plain TRUNCATE stops at
      // the foreign key, a CASCADE still reaches the fare trigger (the named
      // table's trigger fires first).
      await expect(db(t.app).$executeRawUnsafe('TRUNCATE TABLE "fare_entry"')).rejects.toThrow(
        /referenced in a foreign key constraint/,
      );
      await expect(
        db(t.app).$executeRawUnsafe('TRUNCATE TABLE "fare_entry" CASCADE'),
      ).rejects.toThrow(/fare history cannot be truncated/);
      // fare_table_version is referenced by entries and trips: a plain TRUNCATE
      // stops at the foreign key, a CASCADE reaches its trigger.
      await expect(
        db(t.app).$executeRawUnsafe('TRUNCATE TABLE "fare_table_version"'),
      ).rejects.toThrow(/referenced in a foreign key constraint/);
      await expect(
        db(t.app).$executeRawUnsafe('TRUNCATE TABLE "fare_table_version" CASCADE'),
      ).rejects.toThrow(/fare history cannot be truncated/);
      expect(await db(t.app).fareEntry.count({ where: { fareTableVersionId: version.id } })).toBe(
        2,
      );
    });
  });

  describe('trips', () => {
    it('assigns pricing only while DRAFT, published, for the trip route version', async () => {
      const { geo, version } = await pricedVersion();
      const draftPricing = await pricedVersion('DRAFT', geo);
      const elsewhere = await pricedVersion();
      const trip = await draftTrip(geo);
      await expect(
        db(t.app).trip.update({
          where: { id: trip.id },
          data: { fareTableVersionId: draftPricing.version.id },
        }),
      ).rejects.toThrow(/fare table must be a version that has been published/);
      await expect(
        db(t.app).trip.update({
          where: { id: trip.id },
          data: { fareTableVersionId: elsewhere.version.id },
        }),
      ).rejects.toThrow(/must price the trip route version/);
      await expect(
        db(t.app).trip.update({ where: { id: trip.id }, data: { fareTableVersionId: version.id } }),
      ).resolves.toMatchObject({ fareTableVersionId: version.id });

      await schedule(trip.id);
      await expect(
        db(t.app).trip.update({ where: { id: trip.id }, data: { fareTableVersionId: null } }),
      ).rejects.toThrow(/pricing of a scheduled or cancelled trip is frozen/);
      await db(t.app).trip.update({
        where: { id: trip.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await expect(
        db(t.app).$executeRawUnsafe(
          `UPDATE "trip" SET "fare_table_version_id" = NULL WHERE "id" = '${trip.id}'`,
        ),
      ).rejects.toThrow(/immutable/);
      // Changing the pricing while scheduling is refused as well.
      const other = await draftTrip(geo);
      await expect(
        db(t.app).trip.update({
          where: { id: other.id },
          data: { status: 'SCHEDULED', scheduledAt: new Date(), fareTableVersionId: version.id },
        }),
      ).rejects.toThrow(/pricing of a scheduled or cancelled trip is frozen/);
    });

    it('keeps historical trips on a pricing retired, deactivated or whose route was retired later', async () => {
      const { geo, table, version } = await pricedVersion();
      const trip = await draftTrip(geo);
      await db(t.app).trip.update({
        where: { id: trip.id },
        data: { fareTableVersionId: version.id },
      });
      await schedule(trip.id);
      await retire(version.id);
      await db(t.app).fareTable.update({ where: { id: table.id }, data: { active: false } });
      await db(t.app).routeVersion.update({
        where: { id: geo.routeVersionId },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
      expect(await db(t.app).trip.findUniqueOrThrow({ where: { id: trip.id } })).toMatchObject({
        status: 'SCHEDULED',
        fareTableVersionId: version.id,
      });
      await expect(
        db(t.app).trip.update({
          where: { id: trip.id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        }),
      ).resolves.toMatchObject({ status: 'CANCELLED', fareTableVersionId: version.id });
    });

    it('lets trips without pricing be scheduled (PR-06/PR-07 behaviour)', async () => {
      const geo = await route();
      const trip = await draftTrip(geo);
      await expect(schedule(trip.id)).resolves.toMatchObject({
        status: 'SCHEDULED',
        fareTableVersionId: null,
      });
    });
  });

  it('seeds the explicit pricing matrix; trip managers read pricing, pricing managers read the network', async () => {
    const grants = await db(t.app).authorizationRolePermission.findMany({
      where: { permissionKey: { in: ['pricing.read', 'pricing.manage'] } },
      orderBy: [{ permissionKey: 'asc' }, { roleKey: 'asc' }],
      select: { permissionKey: true, roleKey: true },
    });
    expect(grants.map((g) => `${g.permissionKey}:${g.roleKey}`)).toEqual([
      'pricing.manage:DIRECTOR',
      'pricing.manage:OPS_MANAGER',
      'pricing.manage:SUPER_ADMIN',
      'pricing.read:AUDITOR',
      'pricing.read:BOOKING_AGENT',
      'pricing.read:CUSTOMER_SUPPORT',
      'pricing.read:DIRECTOR',
      'pricing.read:DISPATCHER',
      'pricing.read:FINANCE',
      'pricing.read:OPS_MANAGER',
      'pricing.read:SUPER_ADMIN',
    ]);
    const prerequisites: Array<[string, string]> = [
      ['trip.manage', 'pricing.read'],
      ['pricing.manage', 'network.read'],
    ];
    for (const [held, required] of prerequisites) {
      const holders = await db(t.app).authorizationRolePermission.findMany({
        where: { permissionKey: held },
        select: { roleKey: true },
      });
      expect(holders.length).toBeGreaterThan(0);
      for (const { roleKey } of holders) {
        expect(
          await db(t.app).authorizationRolePermission.count({
            where: { roleKey, permissionKey: required },
          }),
          `${roleKey}: ${held} needs ${required}`,
        ).toBe(1);
      }
    }
  });
});
