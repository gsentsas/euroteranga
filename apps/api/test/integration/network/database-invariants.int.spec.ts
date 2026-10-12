import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

let fixtureSequence = 0;

function letters(value: number, width: number): string {
  let result = '';
  for (let position = 0; position < width; position += 1) {
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

describe('network database invariants (isolated database)', () => {
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

  async function country(overrides: { iso2?: string; iso3?: string; name?: string } = {}) {
    const sequence = fixtureSequence++;
    return db(t.app).country.create({
      data: {
        iso2: overrides.iso2 ?? letters(sequence, 2),
        iso3: overrides.iso3 ?? letters(sequence, 3),
        name: overrides.name ?? `Synthetic country ${sequence}`,
      },
    });
  }

  async function stop(
    countryId: string,
    overrides: {
      code?: string;
      name?: string;
      locality?: string;
      latitude?: number;
      longitude?: number;
      timezone?: string;
      active?: boolean;
    } = {},
  ) {
    const sequence = fixtureSequence++;
    return db(t.app).stop.create({
      data: {
        code: overrides.code ?? `STOP_${sequence}`,
        name: overrides.name ?? `Synthetic stop ${sequence}`,
        countryId,
        locality: overrides.locality ?? `Locality ${sequence}`,
        latitude: overrides.latitude ?? 12.345678,
        longitude: overrides.longitude ?? -12.345678,
        timezone: overrides.timezone ?? 'Etc/UTC',
        active: overrides.active ?? true,
      },
    });
  }

  async function checkpoint(
    countryId: string,
    overrides: {
      code?: string;
      type?: 'BORDER' | 'FERRY_TERMINAL' | 'PORT' | 'TECHNICAL';
      latitude?: number;
      longitude?: number;
      active?: boolean;
    } = {},
  ) {
    const sequence = fixtureSequence++;
    return db(t.app).checkpoint.create({
      data: {
        code: overrides.code ?? `CHECK_${sequence}`,
        name: `Synthetic checkpoint ${sequence}`,
        countryId,
        type: overrides.type ?? 'BORDER',
        locality: `Locality ${sequence}`,
        latitude: overrides.latitude ?? 12.345678,
        longitude: overrides.longitude ?? -12.345678,
        timezone: 'Etc/UTC',
        active: overrides.active ?? true,
      },
    });
  }

  async function route(overrides: { code?: string; name?: string } = {}) {
    const sequence = fixtureSequence++;
    return db(t.app).route.create({
      data: {
        code: overrides.code ?? `ROUTE_${sequence}`,
        name: overrides.name ?? `Synthetic route ${sequence}`,
      },
    });
  }

  it('enforces uppercase ISO2/ISO3 formats and independent uniqueness', async () => {
    await country({ iso2: 'XA', iso3: 'XAA' });
    await expect(country({ iso2: 'XA', iso3: 'XAB' })).rejects.toThrow();
    await expect(country({ iso2: 'XB', iso3: 'XAA' })).rejects.toThrow();
    await expect(country({ iso2: 'xc', iso3: 'XAC' })).rejects.toThrow(/country_iso2_format/);
    await expect(country({ iso2: 'XC', iso3: 'xa' })).rejects.toThrow(/country_iso3_format/);
  });

  it('enforces coordinate ranges for stops and checkpoints', async () => {
    const nation = await country();
    await expect(stop(nation.id, { latitude: 90.000001 })).rejects.toThrow(
      /stop_latitude_range/,
    );
    await expect(stop(nation.id, { longitude: -180.000001 })).rejects.toThrow(
      /stop_longitude_range/,
    );
    await expect(checkpoint(nation.id, { latitude: -90.000001 })).rejects.toThrow(
      /checkpoint_latitude_range/,
    );
    await expect(checkpoint(nation.id, { longitude: 180.000001 })).rejects.toThrow(
      /checkpoint_longitude_range/,
    );
    await expect(stop(nation.id, { latitude: 90, longitude: -180 })).resolves.toBeDefined();
    await expect(checkpoint(nation.id, { latitude: -90, longitude: 180 })).resolves.toBeDefined();
  });

  it('requires normalized unique codes for stops, checkpoints and routes', async () => {
    const nation = await country();
    await stop(nation.id, { code: 'STOP_UNIQUE' });
    await expect(stop(nation.id, { code: 'STOP_UNIQUE' })).rejects.toThrow();
    await expect(stop(nation.id, { code: 'stop_lower' })).rejects.toThrow(
      /stop_code_normalized/,
    );

    await checkpoint(nation.id, { code: 'CHECK_UNIQUE' });
    await expect(checkpoint(nation.id, { code: 'CHECK_UNIQUE' })).rejects.toThrow();
    await expect(checkpoint(nation.id, { code: ' CHECK_PADDED' })).rejects.toThrow(
      /checkpoint_code_normalized/,
    );

    await route({ code: 'ROUTE_UNIQUE' });
    await expect(route({ code: 'ROUTE_UNIQUE' })).rejects.toThrow();
    await expect(route({ code: 'route_lower' })).rejects.toThrow(/route_code_normalized/);
  });

  it('enforces waypoint location, passenger and sequence invariants', async () => {
    const nation = await country();
    const passengerStop = await stop(nation.id);
    const operationalCheckpoint = await checkpoint(nation.id);
    const commercialRoute = await route();
    const version = await db(t.app).routeVersion.create({
      data: { routeId: commercialRoute.id, version: 1 },
    });

    await db(t.app).routeWaypoint.create({
      data: { routeVersionId: version.id, sequence: 1, stopId: passengerStop.id },
    });
    await expect(
      db(t.app).routeWaypoint.create({
        data: {
          routeVersionId: version.id,
          sequence: 2,
          stopId: passengerStop.id,
          checkpointId: operationalCheckpoint.id,
        },
      }),
    ).rejects.toThrow(/route_waypoint_exactly_one_location/);
    await expect(
      db(t.app).routeWaypoint.create({
        data: { routeVersionId: version.id, sequence: 2 },
      }),
    ).rejects.toThrow(/route_waypoint_exactly_one_location/);
    await expect(
      db(t.app).routeWaypoint.create({
        data: {
          routeVersionId: version.id,
          sequence: 2,
          checkpointId: operationalCheckpoint.id,
          boardingAllowed: true,
        },
      }),
    ).rejects.toThrow(/route_waypoint_checkpoint_no_passenger_activity/);
    await expect(
      db(t.app).routeWaypoint.create({
        data: { routeVersionId: version.id, sequence: 0, stopId: passengerStop.id },
      }),
    ).rejects.toThrow(/route_waypoint_sequence_positive/);
    await expect(
      db(t.app).routeWaypoint.create({
        data: { routeVersionId: version.id, sequence: 1, stopId: passengerStop.id },
      }),
    ).rejects.toThrow();
  });

  it('allows at most one DRAFT and one PUBLISHED version per route', async () => {
    const commercialRoute = await route();
    const first = await db(t.app).routeVersion.create({
      data: { routeId: commercialRoute.id, version: 1 },
    });
    await expect(
      db(t.app).routeVersion.create({ data: { routeId: commercialRoute.id, version: 2 } }),
    ).rejects.toThrow();

    await db(t.app).routeVersion.update({
      where: { id: first.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    const second = await db(t.app).routeVersion.create({
      data: { routeId: commercialRoute.id, version: 2 },
    });
    await expect(
      db(t.app).routeVersion.create({ data: { routeId: commercialRoute.id, version: 3 } }),
    ).rejects.toThrow();
    await expect(
      db(t.app).routeVersion.update({
        where: { id: second.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      }),
    ).rejects.toThrow();

    await db(t.app).routeVersion.update({
      where: { id: first.id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
    await expect(
      db(t.app).routeVersion.update({
        where: { id: second.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      }),
    ).resolves.toMatchObject({ status: 'PUBLISHED' });
  });

  it('enforces version numbers, timestamp consistency and lifecycle transitions', async () => {
    const commercialRoute = await route();
    await expect(
      db(t.app).routeVersion.create({ data: { routeId: commercialRoute.id, version: 0 } }),
    ).rejects.toThrow(/route_version_number_positive/);
    await expect(
      db(t.app).routeVersion.create({
        data: {
          routeId: commercialRoute.id,
          version: 1,
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/must be created as DRAFT/);
    await expect(
      db(t.app).routeVersion.create({
        data: { routeId: commercialRoute.id, version: 1, publishedAt: new Date() },
      }),
    ).rejects.toThrow(/route_version_status_timestamps/);

    const draft = await db(t.app).routeVersion.create({
      data: { routeId: commercialRoute.id, version: 1 },
    });
    await expect(
      db(t.app).routeVersion.update({
        where: { id: draft.id },
        data: { status: 'RETIRED', publishedAt: new Date(), retiredAt: new Date() },
      }),
    ).rejects.toThrow(/draft route version may only transition to PUBLISHED/);
  });

  it('makes published and retired route history immutable through direct Prisma writes', async () => {
    const nation = await country();
    const origin = await stop(nation.id);
    const destination = await stop(nation.id);
    const commercialRoute = await route();
    const version = await db(t.app).routeVersion.create({
      data: { routeId: commercialRoute.id, version: 1 },
    });
    const first = await db(t.app).routeWaypoint.create({
      data: { routeVersionId: version.id, sequence: 1, stopId: origin.id },
    });
    await db(t.app).routeWaypoint.create({
      data: { routeVersionId: version.id, sequence: 2, stopId: destination.id },
    });
    const publishedAt = new Date(Date.now() - 1_000);
    await db(t.app).routeVersion.update({
      where: { id: version.id },
      data: { status: 'PUBLISHED', publishedAt },
    });

    await expect(
      db(t.app).routeWaypoint.update({ where: { id: first.id }, data: { sequence: 3 } }),
    ).rejects.toThrow(/waypoints of published or retired route versions are immutable/);
    await expect(db(t.app).routeWaypoint.delete({ where: { id: first.id } })).rejects.toThrow(
      /waypoints of published or retired route versions are immutable/,
    );
    await expect(
      db(t.app).routeWaypoint.create({
        data: { routeVersionId: version.id, sequence: 3, stopId: origin.id },
      }),
    ).rejects.toThrow(/waypoints of published or retired route versions are immutable/);
    await expect(
      db(t.app).routeVersion.update({ where: { id: version.id }, data: { version: 9 } }),
    ).rejects.toThrow(/route version identity is immutable/);
    await expect(db(t.app).routeVersion.delete({ where: { id: version.id } })).rejects.toThrow(
      /published or retired route versions are immutable/,
    );

    await db(t.app).routeVersion.update({
      where: { id: version.id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
    await expect(
      db(t.app).routeVersion.update({
        where: { id: version.id },
        data: { status: 'PUBLISHED', retiredAt: null },
      }),
    ).rejects.toThrow(/retired route versions are immutable/);
    await expect(db(t.app).routeVersion.delete({ where: { id: version.id } })).rejects.toThrow(
      /published or retired route versions are immutable/,
    );
    await expect(db(t.app).$executeRawUnsafe('TRUNCATE TABLE "route_waypoint"')).rejects.toThrow(
      /network route history cannot be truncated/,
    );
  });

  it('uses RESTRICT foreign keys to preserve referenced geography and route history', async () => {
    const nation = await country();
    const passengerStop = await stop(nation.id);
    const operationalCheckpoint = await checkpoint(nation.id);
    const commercialRoute = await route();
    const version = await db(t.app).routeVersion.create({
      data: { routeId: commercialRoute.id, version: 1 },
    });
    await db(t.app).routeWaypoint.createMany({
      data: [
        { routeVersionId: version.id, sequence: 1, stopId: passengerStop.id },
        { routeVersionId: version.id, sequence: 2, checkpointId: operationalCheckpoint.id },
      ],
    });

    await expect(db(t.app).country.delete({ where: { id: nation.id } })).rejects.toThrow();
    await expect(db(t.app).stop.delete({ where: { id: passengerStop.id } })).rejects.toThrow();
    await expect(
      db(t.app).checkpoint.delete({ where: { id: operationalCheckpoint.id } }),
    ).rejects.toThrow();
    await expect(db(t.app).route.delete({ where: { id: commercialRoute.id } })).rejects.toThrow();
    await expect(db(t.app).routeVersion.delete({ where: { id: version.id } })).rejects.toThrow();
  });

  it('seeds the explicit network permission matrix without wildcards', async () => {
    const permissions = await db(t.app).authorizationPermission.findMany({
      where: { key: { in: ['network.read', 'network.manage'] } },
      orderBy: { key: 'asc' },
      select: { key: true },
    });
    expect(permissions.map(({ key }) => key)).toEqual(['network.manage', 'network.read']);

    const grants = await db(t.app).authorizationRolePermission.findMany({
      where: { permissionKey: { in: ['network.read', 'network.manage'] } },
      orderBy: [{ permissionKey: 'asc' }, { roleKey: 'asc' }],
      select: { permissionKey: true, roleKey: true },
    });
    expect(grants).toEqual([
      { permissionKey: 'network.manage', roleKey: 'DIRECTOR' },
      { permissionKey: 'network.manage', roleKey: 'OPS_MANAGER' },
      { permissionKey: 'network.manage', roleKey: 'SUPER_ADMIN' },
      { permissionKey: 'network.read', roleKey: 'AUDITOR' },
      { permissionKey: 'network.read', roleKey: 'BOOKING_AGENT' },
      { permissionKey: 'network.read', roleKey: 'COMPLIANCE_AGENT' },
      { permissionKey: 'network.read', roleKey: 'CUSTOMER_SUPPORT' },
      { permissionKey: 'network.read', roleKey: 'DIRECTOR' },
      { permissionKey: 'network.read', roleKey: 'DISPATCHER' },
      { permissionKey: 'network.read', roleKey: 'OPS_MANAGER' },
      { permissionKey: 'network.read', roleKey: 'SUPER_ADMIN' },
    ]);
  });
});
