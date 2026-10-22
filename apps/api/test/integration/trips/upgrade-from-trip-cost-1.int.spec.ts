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
const TRIP_COST_MIGRATION = '20261022090000_trip_cost';
const CONVOY_MIGRATION = '20261022130000_convoy_support';
const TRIP_ID = '01900000-0000-7000-8000-000000000501';

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

describe('upgrade from TRIP-COST-1 to CONVOY-1 (isolated database)', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let url: string;
  let workDir: string;
  const name = `et_convoy_${randomBytes(6).toString('hex')}`;

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  beforeAll(async () => {
    expect(CURRENT_MIGRATIONS.at(-1)).toBe(CONVOY_MIGRATION);
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-convoy-upgrade-'));
    const previous = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= TRIP_COST_MIGRATION) {
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
    expect((await applied()).at(-1)).toBe(TRIP_COST_MIGRATION);

    await raw.$executeRawUnsafe(`
      INSERT INTO country (id, iso2, iso3, name, active, created_at, updated_at)
      VALUES ('01900000-0000-7000-8000-000000000502', 'CY', 'CNY', 'Pays upgrade convoi', true, now(), now());
      INSERT INTO stop (id, code, name, country_id, locality, latitude, longitude, timezone, active, created_at, updated_at)
      VALUES
        ('01900000-0000-7000-8000-000000000503', 'CONVOY_UP_A', 'Arrêt A', '01900000-0000-7000-8000-000000000502', 'A', 1, 1, 'Etc/UTC', true, now(), now()),
        ('01900000-0000-7000-8000-000000000504', 'CONVOY_UP_B', 'Arrêt B', '01900000-0000-7000-8000-000000000502', 'B', 2, 2, 'Etc/UTC', true, now(), now());
      INSERT INTO route (id, code, name, active, created_at, updated_at)
      VALUES ('01900000-0000-7000-8000-000000000505', 'CONVOY_UP_ROUTE', 'Route upgrade convoi', true, now(), now());
      INSERT INTO route_version (id, route_id, version, status, created_at, updated_at)
      VALUES ('01900000-0000-7000-8000-000000000506', '01900000-0000-7000-8000-000000000505', 1, 'DRAFT', now(), now());
      INSERT INTO route_waypoint (id, route_version_id, sequence, stop_id, boarding_allowed, alighting_allowed)
      VALUES
        ('01900000-0000-7000-8000-000000000507', '01900000-0000-7000-8000-000000000506', 1, '01900000-0000-7000-8000-000000000503', true, false),
        ('01900000-0000-7000-8000-000000000508', '01900000-0000-7000-8000-000000000506', 2, '01900000-0000-7000-8000-000000000504', false, true);
      UPDATE route_version SET status = 'PUBLISHED', published_at = now(), updated_at = now()
      WHERE id = '01900000-0000-7000-8000-000000000506';
      INSERT INTO trip (id, reference, route_version_id, status, created_at, updated_at)
      VALUES ('${TRIP_ID}', 'ET-CONVOY-UPGRADE', '01900000-0000-7000-8000-000000000506', 'DRAFT', now(), now());
    `);

    deploy(null, url);
  }, 60_000);

  afterAll(async () => {
    await raw?.$disconnect();
    await root?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root?.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('preserves the existing trip and leaves support unassigned', async () => {
    const rows = await raw.$queryRawUnsafe<
      Array<{ id: string; reference: string; status: string; support_vehicle_id: string | null }>
    >(
      `SELECT id, reference, status::text AS status, support_vehicle_id
       FROM trip WHERE id = '${TRIP_ID}'`,
    );
    expect(rows).toEqual([
      {
        id: TRIP_ID,
        reference: 'ET-CONVOY-UPGRADE',
        status: 'DRAFT',
        support_vehicle_id: null,
      },
    ]);
    expect(await applied()).toEqual(CURRENT_MIGRATIONS);
  });

  it('deploys a second time without drift', async () => {
    deploy(null, url);
    const status = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(status).toContain('Database schema is up to date');
    expect(await applied()).toEqual(CURRENT_MIGRATIONS);
  });
});
