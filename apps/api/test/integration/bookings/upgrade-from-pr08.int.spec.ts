import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@euroteranga/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const PRICING_MIGRATION = '20261013180000_pricing';
const BOOKING_MIGRATION = '20261013210000_booking';

const TRIP = '01900000-0000-7000-8000-000000000081';
const SEAT_MAP_VERSION = '01900000-0000-7000-8000-0000000000e2';
const FARE_VERSION = '01900000-0000-7000-8000-0000000000f8';
const VEHICLE = '01900000-0000-7000-8000-0000000000f1';
const ROUTE_VERSION = '01900000-0000-7000-8000-0000000000b2';
const ORIGIN = '01900000-0000-7000-8000-0000000000d1';
const DESTINATION = '01900000-0000-7000-8000-0000000000d2';

/**
 * A PR-08 database: published route, seat map and fare table, an ACTIVE
 * vehicle and a SCHEDULED trip with its historical seat map and pricing.
 */
const PR08_DATA = [
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
    (gen_random_uuid(), '${SEAT_MAP_VERSION}', 1, 2, 1, 'SEAT', '1A'),
    (gen_random_uuid(), '${SEAT_MAP_VERSION}', 1, 2, 2, 'SEAT', '1B')`,
  `UPDATE seat_map_version SET status = 'PUBLISHED', published_at = now() WHERE id = '${SEAT_MAP_VERSION}'`,
  `INSERT INTO fare_table (id, code, name, route_id, currency_code, currency_minor_unit, updated_at) VALUES
    ('01900000-0000-7000-8000-0000000000f7', 'UPG_FT', 'Grille montée de version', '01900000-0000-7000-8000-0000000000b1', 'XOF', 0, now())`,
  `INSERT INTO fare_table_version (id, fare_table_id, route_version_id, version, updated_at) VALUES
    ('${FARE_VERSION}', '01900000-0000-7000-8000-0000000000f7', '${ROUTE_VERSION}', 1, now())`,
  `INSERT INTO fare_entry (id, fare_table_version_id, origin_route_waypoint_id, destination_route_waypoint_id, amount_minor) VALUES
    (gen_random_uuid(), '${FARE_VERSION}', '${ORIGIN}', '${DESTINATION}', 15000)`,
  `UPDATE fare_table_version SET status = 'PUBLISHED', published_at = now() WHERE id = '${FARE_VERSION}'`,
  `INSERT INTO vehicle (id, code, manufacturer, model, updated_at) VALUES ('${VEHICLE}', 'VH_UPGRADE', 'Constructeur synthétique', 'Montée', now())`,
  `UPDATE vehicle SET status = 'ACTIVE', status_changed_at = now() WHERE id = '${VEHICLE}'`,
  `UPDATE vehicle SET seat_map_version_id = '${SEAT_MAP_VERSION}' WHERE id = '${VEHICLE}'`,
  `INSERT INTO trip (id, reference, route_version_id, vehicle_id, seat_map_version_id, fare_table_version_id, updated_at) VALUES
    ('${TRIP}', 'ET-TEST-UPGRADE-08', '${ROUTE_VERSION}', '${VEHICLE}', '${SEAT_MAP_VERSION}', '${FARE_VERSION}', now())`,
  `INSERT INTO trip_waypoint_timing (id, trip_id, route_waypoint_id, sequence, planned_departure_at, planned_arrival_at) VALUES
    (gen_random_uuid(), '${TRIP}', '${ORIGIN}', 1, '2030-05-01T08:00:00Z', NULL),
    (gen_random_uuid(), '${TRIP}', '${DESTINATION}', 2, NULL, '2030-05-01T12:00:00Z')`,
  `UPDATE trip SET planned_departure_at = '2030-05-01T08:00:00Z', planned_arrival_at = '2030-05-01T12:00:00Z' WHERE id = '${TRIP}'`,
  `UPDATE trip SET status = 'SCHEDULED', scheduled_at = now() WHERE id = '${TRIP}'`,
];

const SNAPSHOTS = {
  trip: `SELECT row_to_json(t)::text AS value FROM (SELECT id, reference, status, route_version_id, vehicle_id, seat_map_version_id, fare_table_version_id, planned_departure_at, planned_arrival_at, scheduled_at, created_at, updated_at FROM trip) t`,
  timings: `SELECT json_agg(t ORDER BY t.sequence)::text AS value FROM (SELECT trip_id, route_waypoint_id, sequence, planned_arrival_at, planned_departure_at FROM trip_waypoint_timing) t`,
  cells: `SELECT json_agg(c ORDER BY c.deck, c.row_number, c.column_number)::text AS value FROM seat_map_cell c`,
  fares: `SELECT json_agg(f ORDER BY f.id)::text AS value FROM fare_entry f`,
  fareVersions: `SELECT json_agg(v ORDER BY v.id)::text AS value FROM fare_table_version v`,
  vehicle: `SELECT row_to_json(v)::text AS value FROM (SELECT id, status, seat_map_version_id FROM vehicle) v`,
  // Grants added by later migrations (booking.*, payment.* and PR-11
  // passenger-document reads) aside.
  grants: `SELECT json_agg(g ORDER BY g.role_key, g.permission_key)::text AS value FROM authorization_role_permission g WHERE g.permission_key NOT LIKE 'booking.%' AND g.permission_key NOT LIKE 'payment.%' AND g.permission_key <> 'passenger.document.read'`,
};

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

/**
 * Upgrade of an existing PR-08 database: only the booking migration is
 * applied by `prisma migrate deploy`, with a SCHEDULED trip carrying its
 * historical seat map and pricing. The PR-09 state is measured right after
 * that step; later migrations (PR-10 and on) are then applied, as a
 * deployment would, before the API starts.
 */
describe('upgrade from a PR-08 database (isolated database)', () => {
  let t: TestApp;
  let admin: StaffActor;
  let url: string;
  let workDir: string;
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  const name = `et_upg_${randomBytes(6).toString('hex')}`;
  const before: Record<string, string> = {};
  const afterBooking: {
    applied: string[];
    snapshot: Record<string, string>;
    counts: Record<string, number>;
  } = { applied: [], snapshot: {}, counts: {} };

  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(SNAPSHOTS).map(async ([key, sql]) => {
          const [row] = await raw.$queryRawUnsafe<Array<{ value: string }>>(sql);
          return [key, row!.value] as const;
        }),
      ),
    );
  const appliedMigrations = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);
  const count = async (sql: string) =>
    Number((await raw.$queryRawUnsafe<Array<{ count: bigint }>>(sql))[0]!.count);

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
    // The PR-08 migration set: every migration up to and including pricing.
    deploy(
      migrationSet('pr08', (entry) => entry <= PRICING_MIGRATION),
      url,
    );

    raw = createDatabaseClient({ databaseUrl: url });
    expect(await appliedMigrations()).toHaveLength(8);
    expect(
      await count(
        `SELECT count(*) AS count FROM information_schema.tables WHERE table_name = 'booking'`,
      ),
    ).toBe(0);
    for (const statement of PR08_DATA) await raw.$executeRawUnsafe(statement);
    Object.assign(before, await snapshot());

    // The PR-09 migration set: only the booking migration is pending.
    deploy(
      migrationSet('pr09', (entry) => entry <= BOOKING_MIGRATION),
      url,
    );
    afterBooking.applied = await appliedMigrations();
    afterBooking.snapshot = await snapshot();
    for (const table of ['booking', 'booking_seat', 'seat_inventory_lock']) {
      afterBooking.counts[table] = await count(`SELECT count(*) AS count FROM "${table}"`);
    }
    afterBooking.counts.permissions = await count(
      `SELECT count(*) AS count FROM authorization_permission WHERE key LIKE 'booking.%'`,
    );
    afterBooking.counts.grants = await count(
      `SELECT count(*) AS count FROM authorization_role_permission WHERE permission_key LIKE 'booking.%'`,
    );
    // The real directory: later migrations (PR-10 and on), as deployed.
    deploy(null, url);
    t = await startTestApp(integrationEnv({ DATABASE_URL: url }));
    admin = await staffActor(t.app, ['SUPER_ADMIN']);
    // Same budget as the PR-07 upgrade test: three `prisma migrate deploy`
    // processes (~2.5 s each when idle, measured; several times that under
    // the parallel integration load), the API start and a STAFF enrollment.
  }, 60_000);

  afterAll(async () => {
    await t?.app.close();
    await raw?.$disconnect();
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('applies only the booking migration and leaves PR-08 data untouched', async () => {
    const applied = afterBooking.applied;
    expect(applied).toHaveLength(9);
    expect(applied.at(-1)).toBe(BOOKING_MIGRATION);
    expect(afterBooking.snapshot).toEqual(before);
    for (const table of ['booking', 'booking_seat', 'seat_inventory_lock']) {
      expect(afterBooking.counts[table], table).toBe(0);
    }
    expect(afterBooking.counts.permissions).toBe(2);
    expect(afterBooking.counts.grants).toBe(10);
    // Still true once the later migrations are applied.
    expect(await snapshot()).toEqual(before);
    for (const table of ['booking', 'booking_seat', 'seat_inventory_lock']) {
      expect(await count(`SELECT count(*) AS count FROM "${table}"`), table).toBe(0);
    }
    expect(
      await count(
        `SELECT count(*) AS count FROM authorization_role_permission WHERE permission_key LIKE 'booking.%'`,
      ),
    ).toBe(10);
  });

  it('makes the historical trip bookable with its own seat map and pricing', async () => {
    const response = await request(t.app.getHttpServer()).get(
      `/v1/booking/trips/${TRIP}/availability?originRouteWaypointId=${ORIGIN}&destinationRouteWaypointId=${DESTINATION}`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      seatMapVersionId: SEAT_MAP_VERSION,
      fare: { amountMinor: 15000, currencyCode: 'XOF', currencyMinorUnit: 0 },
      seatCount: 2,
      availableSeatCount: 2,
    });
  });

  it('keeps the trip cancellable, after which it is immutable and not bookable', async () => {
    const cancelled = await adminApi(admin).post(`/trips/${TRIP}/cancel`, {
      reason: 'Montée de version',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      seatMapVersionId: SEAT_MAP_VERSION,
      fareTableVersionId: FARE_VERSION,
    });
    await expect(
      raw.$executeRawUnsafe(`UPDATE trip SET vehicle_id = NULL WHERE id = '${TRIP}'`),
    ).rejects.toThrow(/cancelled trips are immutable/);
    const after = await snapshot();
    for (const key of ['timings', 'cells', 'fares', 'fareVersions', 'vehicle', 'grants'] as const) {
      expect(after[key], key).toBe(before[key]);
    }
    const unavailable = await request(t.app.getHttpServer()).get(
      `/v1/booking/trips/${TRIP}/availability?originRouteWaypointId=${ORIGIN}&destinationRouteWaypointId=${DESTINATION}`,
    );
    expect(unavailable.body.code).toBe('BOOKING_TRIP_NOT_BOOKABLE');
  });
});
