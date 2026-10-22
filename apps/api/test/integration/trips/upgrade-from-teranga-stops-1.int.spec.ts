import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_MIGRATIONS } from '../../support/migrations.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const TERANGA_STOPS_MIGRATION = '20261021220000_teranga_stops';
const TRIP_COST_MIGRATION = '20261022090000_trip_cost';
const TRIP_ID = '01900000-0000-7000-8000-000000000401';

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

/** Additive upgrade over a populated TERANGA-STOPS-1 schema through the current schema. */
describe('upgrade from TERANGA-STOPS-1 through TRIP-COST-1 (isolated database)', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let url: string;
  let workDir: string;
  let beforeTrip: string;
  const name = `et_trip_cost_${randomBytes(6).toString('hex')}`;

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  const tripSnapshot = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ value: string }>>(
        `SELECT (to_jsonb(t) - 'support_vehicle_id')::text AS value
         FROM (SELECT * FROM trip WHERE id = '${TRIP_ID}') t`,
      )
    )[0]!.value;

  beforeAll(async () => {
    expect(CURRENT_MIGRATIONS).toContain(TRIP_COST_MIGRATION);
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-trip-cost-upgrade-'));
    const previous = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= TERANGA_STOPS_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(previous, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: previous },
        datasource: { url },
      })};\n`,
    );
    deploy(config, url);
    raw = createDatabaseClient({ databaseUrl: url });
    expect((await applied()).at(-1)).toBe(TERANGA_STOPS_MIGRATION);

    await raw.$executeRawUnsafe(`
      INSERT INTO country (id, iso2, iso3, name, active, created_at, updated_at)
      VALUES ('01900000-0000-7000-8000-000000000402', 'QX', 'QXX', 'Pays upgrade coûts', true, now(), now());
      INSERT INTO stop (id, code, name, country_id, locality, latitude, longitude, timezone, active, created_at, updated_at)
      VALUES
        ('01900000-0000-7000-8000-000000000403', 'COST_UP_A', 'Arrêt A', '01900000-0000-7000-8000-000000000402', 'A', 1, 1, 'Etc/UTC', true, now(), now()),
        ('01900000-0000-7000-8000-000000000404', 'COST_UP_B', 'Arrêt B', '01900000-0000-7000-8000-000000000402', 'B', 2, 2, 'Etc/UTC', true, now(), now());
      INSERT INTO route (id, code, name, active, created_at, updated_at)
      VALUES ('01900000-0000-7000-8000-000000000405', 'COST_UP_ROUTE', 'Route upgrade coûts', true, now(), now());
      INSERT INTO route_version (id, route_id, version, status, created_at, updated_at)
      VALUES ('01900000-0000-7000-8000-000000000406', '01900000-0000-7000-8000-000000000405', 1, 'DRAFT', now(), now());
      INSERT INTO route_waypoint (id, route_version_id, sequence, stop_id, boarding_allowed, alighting_allowed)
      VALUES
        ('01900000-0000-7000-8000-000000000407', '01900000-0000-7000-8000-000000000406', 1, '01900000-0000-7000-8000-000000000403', true, false),
        ('01900000-0000-7000-8000-000000000408', '01900000-0000-7000-8000-000000000406', 2, '01900000-0000-7000-8000-000000000404', false, true);
      UPDATE route_version SET status = 'PUBLISHED', published_at = now(), updated_at = now()
      WHERE id = '01900000-0000-7000-8000-000000000406';
      INSERT INTO trip (id, reference, route_version_id, status, created_at, updated_at)
      VALUES ('${TRIP_ID}', 'ET-COST-UPGRADE', '01900000-0000-7000-8000-000000000406', 'DRAFT', now(), now());
    `);
    beforeTrip = await tripSnapshot();

    deploy(null, url);
  }, 60_000);

  afterAll(async () => {
    await raw?.$disconnect();
    await root?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root?.$disconnect();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('preserves the existing trip and invents no operational cost', async () => {
    expect(await tripSnapshot()).toBe(beforeTrip);
    expect(await applied()).toEqual(CURRENT_MIGRATIONS);
    const [plans, items] = await Promise.all([
      raw.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) AS count FROM trip_cost_plan'),
      raw.$queryRawUnsafe<Array<{ count: bigint }>>('SELECT count(*) AS count FROM trip_cost_item'),
    ]);
    expect(Number(plans[0]!.count)).toBe(0);
    expect(Number(items[0]!.count)).toBe(0);
  });

  it('deploys a second time without drift and reports the full history', async () => {
    deploy(null, url);
    const status = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(status).toContain('Database schema is up to date');
    expect(await applied()).toEqual(CURRENT_MIGRATIONS);
    expect(await tripSnapshot()).toBe(beforeTrip);
  });
});
