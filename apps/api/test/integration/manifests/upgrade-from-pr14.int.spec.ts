import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiEnv } from '@euroteranga/config';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { customerActor, type CustomerActor } from '../../support/booking-helpers.js';
import { compliantPassenger, staffCheckInApi } from '../../support/check-in-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const PR14_MIGRATION = '20261014190000_check_in_boarding';
const REPORTING_MIGRATION = '20261017160000_reporting';
const HISTORICAL_TABLES = [
  'trip',
  'booking',
  'booking_seat',
  'seat_inventory_lock',
  'payment',
  'payment_event',
  'passenger',
  'booking_passenger',
  'booking_passenger_seat',
  'passenger_check_in',
  'passenger_boarding',
  'audit_event',
] as const;

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

describe('upgrade from a real PR-14 database', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let director: StaffActor;
  let agent: StaffActor;
  let workDir: string;
  let url: string;
  let before: Record<string, string | null>;
  const name = `et_pr14_${randomBytes(6).toString('hex')}`;

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  const snapshot = async () => {
    const rows: Array<readonly [string, string | null]> = [];
    // Keep this upgrade test friendly to small disposable PostgreSQL pools:
    // the suite already runs several isolated historical upgrades in parallel.
    for (const table of HISTORICAL_TABLES) {
      const historicalJson =
        table === 'trip'
          ? "to_jsonb(x) - ARRAY['actual_departure_at', 'actual_arrival_at', 'departure_authorization_id']"
          : 'to_jsonb(x)';
      const [row] = await raw.$queryRawUnsafe<Array<{ value: string | null }>>(
        `SELECT jsonb_agg(${historicalJson} ORDER BY ${historicalJson})::text AS value FROM (SELECT * FROM "${table}") x`,
      );
      rows.push([table, row!.value] as const);
    }
    return Object.fromEntries(rows);
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-pr14-upgrade-'));
    const pr14 = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= PR14_MIGRATION)
        cpSync(join(MIGRATIONS, entry), join(pr14, entry), { recursive: true });
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: pr14 },
        datasource: { url },
      })};\n`,
    );
    deploy(config, url);
    raw = createDatabaseClient({ databaseUrl: url });
    expect(await applied()).toHaveLength(14);
    expect((await applied()).at(-1)).toBe(PR14_MIGRATION);

    env = integrationEnv({ DATABASE_URL: url });
    t = await startTestApp(env);
    [customer, director, agent] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['BOOKING_AGENT']),
    ]);
    const ready = await compliantPassenger(t.app, env, customer, director);
    const checkedIn = await staffCheckInApi(agent).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    if (checkedIn.status !== 201) throw new Error(`PR-14 fixture failed: ${checkedIn.text}`);
    before = await snapshot();

    deploy(null, url);
  }, 90_000);

  afterAll(async () => {
    await t?.app.close();
    await raw?.$disconnect();
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('applies only PR-15, preserves PR-14 rows and backfills no manifest', async () => {
    const migrations = await applied();
    expect(migrations).toHaveLength(23);
    expect(migrations.at(-1)).toBe(REPORTING_MIGRATION);
    expect(await snapshot()).toEqual(before);
    const [manifestCount, permissionCount, grantCount] = await Promise.all([
      raw.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT count(*) AS count FROM "passenger_manifest"',
      ),
      raw.$queryRawUnsafe<Array<{ count: bigint }>>(
        "SELECT count(*) AS count FROM authorization_permission WHERE key LIKE 'manifest.%'",
      ),
      raw.$queryRawUnsafe<Array<{ count: bigint }>>(
        "SELECT count(*) AS count FROM authorization_role_permission WHERE permission_key LIKE 'manifest.%'",
      ),
    ]);
    expect(Number(manifestCount[0]!.count)).toBe(0);
    expect(Number(permissionCount[0]!.count)).toBe(3);
    expect(Number(grantCount[0]!.count)).toBe(12);
  });

  it('is idempotent under a second deploy and reports all 23 migrations applied', async () => {
    deploy(null, url);
    expect(await applied()).toHaveLength(23);
    const status = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(status).toContain('Database schema is up to date');
  });
});
