import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const PRICING_MIGRATION = '20261013180000_pricing';

const TRIP = '01900000-0000-7000-8000-000000000071';
const SEAT_MAP_VERSION = '01900000-0000-7000-8000-0000000000e2';
const VEHICLE = '01900000-0000-7000-8000-0000000000f1';
const ROUTE_VERSION = '01900000-0000-7000-8000-0000000000b2';
const ORIGIN = '01900000-0000-7000-8000-0000000000d1';
const DESTINATION = '01900000-0000-7000-8000-0000000000d2';

/** A PR-07 database: synthetic route, seat map, vehicle and SCHEDULED trip. */
const PR07_DATA = [
  `INSERT INTO country (id, iso2, iso3, name, updated_at) VALUES ('01900000-0000-7000-8000-0000000000c1', 'QU', 'QUU', 'Pays montée de version', now())`,
  `INSERT INTO stop (id, code, name, country_id, locality, latitude, longitude, timezone, updated_at) VALUES
    ('01900000-0000-7000-8000-0000000000a1', 'UPG_A', 'Arrêt A synthétique', '01900000-0000-7000-8000-0000000000c1', 'L', 1, 1, 'Etc/UTC', now()),
    ('01900000-0000-7000-8000-0000000000a2', 'UPG_B', 'Arrêt B synthétique', '01900000-0000-7000-8000-0000000000c1', 'L', 1, 1, 'Etc/UTC', now())`,
  `INSERT INTO route (id, code, name, updated_at) VALUES ('01900000-0000-7000-8000-0000000000b1', 'UPG_ROUTE', 'Route montée de version', now())`,
  `INSERT INTO route_version (id, route_id, version, updated_at) VALUES ('${ROUTE_VERSION}', '01900000-0000-7000-8000-0000000000b1', 1, now())`,
  `INSERT INTO route_waypoint (id, route_version_id, sequence, stop_id, boarding_allowed, alighting_allowed) VALUES
    ('${ORIGIN}', '${ROUTE_VERSION}', 1, '01900000-0000-7000-8000-0000000000a1', true, false),
    ('${DESTINATION}', '${ROUTE_VERSION}', 2, '01900000-0000-7000-8000-0000000000a2', false, true)`,
  `UPDATE route_version SET status = 'PUBLISHED', published_at = now() WHERE id = '${ROUTE_VERSION}'`,
  `INSERT INTO seat_map (id, code, name, updated_at) VALUES ('01900000-0000-7000-8000-0000000000e1', 'UPG_SM', 'Plan montée de version', now())`,
  `INSERT INTO seat_map_version (id, seat_map_id, version, updated_at) VALUES ('${SEAT_MAP_VERSION}', '01900000-0000-7000-8000-0000000000e1', 1, now())`,
  `INSERT INTO seat_map_cell (id, seat_map_version_id, deck, row_number, column_number, kind, seat_label) VALUES
    (gen_random_uuid(), '${SEAT_MAP_VERSION}', 1, 1, 1, 'DRIVER', NULL),
    (gen_random_uuid(), '${SEAT_MAP_VERSION}', 1, 2, 1, 'SEAT', '1A')`,
  `UPDATE seat_map_version SET status = 'PUBLISHED', published_at = now() WHERE id = '${SEAT_MAP_VERSION}'`,
  `INSERT INTO vehicle (id, code, manufacturer, model, updated_at) VALUES ('${VEHICLE}', 'VH_UPGRADE', 'Constructeur synthétique', 'Montée', now())`,
  `UPDATE vehicle SET status = 'ACTIVE', status_changed_at = now() WHERE id = '${VEHICLE}'`,
  `UPDATE vehicle SET seat_map_version_id = '${SEAT_MAP_VERSION}' WHERE id = '${VEHICLE}'`,
  `INSERT INTO trip (id, reference, route_version_id, vehicle_id, seat_map_version_id, updated_at) VALUES
    ('${TRIP}', 'ET-TEST-UPGRADE-07', '${ROUTE_VERSION}', '${VEHICLE}', '${SEAT_MAP_VERSION}', now())`,
  `INSERT INTO trip_waypoint_timing (id, trip_id, route_waypoint_id, sequence, planned_departure_at, planned_arrival_at) VALUES
    (gen_random_uuid(), '${TRIP}', '${ORIGIN}', 1, '2030-05-01T08:00:00Z', NULL),
    (gen_random_uuid(), '${TRIP}', '${DESTINATION}', 2, NULL, '2030-05-01T12:00:00Z')`,
  `UPDATE trip SET planned_departure_at = '2030-05-01T08:00:00Z', planned_arrival_at = '2030-05-01T12:00:00Z' WHERE id = '${TRIP}'`,
  `UPDATE trip SET status = 'SCHEDULED', scheduled_at = now() WHERE id = '${TRIP}'`,
];

const SNAPSHOTS = {
  trip: `SELECT row_to_json(t)::text AS value FROM (SELECT id, reference, status, route_version_id, vehicle_id, seat_map_version_id, planned_departure_at, planned_arrival_at, scheduled_at, created_at, updated_at FROM trip) t`,
  timings: `SELECT json_agg(t ORDER BY t.sequence)::text AS value FROM (SELECT trip_id, route_waypoint_id, sequence, planned_arrival_at, planned_departure_at FROM trip_waypoint_timing) t`,
  cells: `SELECT json_agg(c ORDER BY c.deck, c.row_number, c.column_number)::text AS value FROM seat_map_cell c`,
  vehicle: `SELECT row_to_json(v)::text AS value FROM (SELECT id, status, seat_map_version_id FROM vehicle) v`,
};

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'ignore',
    },
  );
}

/**
 * Upgrade of an existing PR-07 database: the pricing migration is applied by
 * `prisma migrate deploy` on top of the seven earlier migrations, with a
 * SCHEDULED trip (vehicle, seat map, timetable) already present. The PR-08
 * state is measured right after that step; later migrations (PR-09 and on)
 * are then applied, as a deployment would, before the API starts.
 */
describe('upgrade from a PR-07 database (isolated database)', () => {
  let t: TestApp;
  let admin: StaffActor;
  let url: string;
  let workDir: string;
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  const name = `et_upg_${randomBytes(6).toString('hex')}`;
  const before: Record<string, string> = {};
  const afterPricing: {
    applied: string[];
    fareColumn: boolean;
    snapshot: Record<string, string>;
    trip: unknown;
  } = { applied: [], fareColumn: false, snapshot: {}, trip: null };

  const snapshot = async (client: ReturnType<typeof createDatabaseClient>) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(SNAPSHOTS).map(async ([key, sql]) => {
          const [row] = await client.$queryRawUnsafe<Array<{ value: string }>>(sql);
          return [key, row!.value] as const;
        }),
      ),
    );
  const appliedMigrations = async (client: ReturnType<typeof createDatabaseClient>) =>
    (
      await client.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);
  const hasFareColumn = async (client: ReturnType<typeof createDatabaseClient>) =>
    (
      await client.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM information_schema.columns WHERE table_name = 'trip' AND column_name = 'fare_table_version_id'`,
      )
    )[0]!.count === 1n;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    // A migration set: every migration of the real directory up to a bound.
    workDir = mkdtempSync(join(tmpdir(), 'et-upgrade-'));
    const migrationSet = (label: string, include: (entry: string) => boolean) => {
      const path = join(workDir, label, 'migrations');
      for (const entry of readdirSync(MIGRATIONS)) {
        if (include(entry)) cpSync(join(MIGRATIONS, entry), join(path, entry), { recursive: true });
      }
      const config = join(workDir, label, 'prisma.config.mjs');
      writeFileSync(
        config,
        `export default ${JSON.stringify({
          schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
          migrations: { path },
          datasource: { url },
        })};\n`,
      );
      return config;
    };
    // The PR-07 migration set: every migration before the pricing one.
    deploy(
      migrationSet('pr07', (entry) => entry < PRICING_MIGRATION),
      url,
    );

    raw = createDatabaseClient({ databaseUrl: url });
    expect(await appliedMigrations(raw)).toHaveLength(7);
    expect(await hasFareColumn(raw)).toBe(false);
    for (const statement of PR07_DATA) await raw.$executeRawUnsafe(statement);
    Object.assign(before, await snapshot(raw));

    // The PR-08 migration set: only the pricing migration is pending.
    deploy(
      migrationSet('pr08', (entry) => entry <= PRICING_MIGRATION),
      url,
    );
    afterPricing.applied = await appliedMigrations(raw);
    afterPricing.fareColumn = await hasFareColumn(raw);
    afterPricing.snapshot = await snapshot(raw);
    [afterPricing.trip] = await raw.$queryRawUnsafe<unknown[]>(
      `SELECT status, fare_table_version_id FROM trip WHERE id = '${TRIP}'`,
    );
    // The real directory: later migrations (PR-09 and on), as deployed.
    deploy(null, url);
    t = await startTestApp(integrationEnv({ DATABASE_URL: url }));
    admin = await staffActor(t.app, ['SUPER_ADMIN']);
    // Budget for three `prisma migrate deploy` processes (~2.5 s each when
    // idle, measured; several times that under the parallel integration
    // load), the API start and a STAFF enrollment (Argon2 + TOTP).
  }, 60_000);

  afterAll(async () => {
    await t?.app.close();
    await raw?.$disconnect();
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('applies only the pricing migration and leaves PR-07 history untouched', async () => {
    const applied = afterPricing.applied;
    expect(applied).toHaveLength(8);
    expect(applied.at(-1)).toBe(PRICING_MIGRATION);
    expect(afterPricing.fareColumn).toBe(true);
    expect(afterPricing.snapshot).toEqual(before);
    expect(afterPricing.trip).toEqual({ status: 'SCHEDULED', fare_table_version_id: null });
    // Still true once the later migrations are applied.
    expect(await hasFareColumn(raw)).toBe(true);
    expect(await snapshot(raw)).toEqual(before);
    const [trip] = await raw.$queryRawUnsafe<
      Array<{ status: string; fare_table_version_id: string | null }>
    >(`SELECT status, fare_table_version_id FROM trip WHERE id = '${TRIP}'`);
    expect(trip).toEqual({ status: 'SCHEDULED', fare_table_version_id: null });
  });

  it('keeps the scheduled trip valid and readable without pricing', async () => {
    const detail = await adminApi(admin).get(`/trips/${TRIP}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      status: 'SCHEDULED',
      fareTableVersionId: null,
      fareTableVersion: null,
      seatMapVersion: { id: SEAT_MAP_VERSION, seatCount: 1 },
      vehicle: { id: VEHICLE },
    });
    const fare = await adminApi(admin).get(
      `/trips/${TRIP}/fare?originRouteWaypointId=${ORIGIN}&destinationRouteWaypointId=${DESTINATION}`,
    );
    expect(fare.status).toBe(422);
    expect(fare.body.code).toBe('TRIP_PRICING_NOT_CONFIGURED');
    // Scheduled: frozen for pricing (PR-08) and seat map (PR-07) alike.
    await expect(
      raw.$executeRawUnsafe(`UPDATE trip SET seat_map_version_id = NULL WHERE id = '${TRIP}'`),
    ).rejects.toThrow(/seat map of a scheduled or cancelled trip is frozen/);
    expect(
      (await adminApi(admin).post(`/trips/${TRIP}/fare-table`, { fareTableVersionId: null })).body
        .code,
    ).toBe('TRIP_NOT_DRAFT');
  });

  it('can still be cancelled, after which it is immutable', async () => {
    const cancelled = await adminApi(admin).post(`/trips/${TRIP}/cancel`, {
      reason: 'Montée de version',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      fareTableVersionId: null,
      seatMapVersion: { id: SEAT_MAP_VERSION },
    });
    await expect(
      raw.$executeRawUnsafe(`UPDATE trip SET vehicle_id = NULL WHERE id = '${TRIP}'`),
    ).rejects.toThrow(/cancelled trips are immutable/);
    const after = await snapshot(raw);
    expect(after.timings).toBe(before.timings);
    expect(after.cells).toBe(before.cells);
  });
});
