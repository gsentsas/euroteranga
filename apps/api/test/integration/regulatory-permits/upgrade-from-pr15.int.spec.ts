import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateManifestReference,
  MANIFEST_SCHEMA_VERSION,
} from '../../../src/manifests/manifest-rules.js';
import { createIdentity, db } from '../../support/auth-helpers.js';
import { bookableFixture } from '../../support/booking-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';
import { CURRENT_MIGRATIONS } from '../../support/migrations.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const PR15_MIGRATION = '20261015090000_passenger_manifests';
const REPORTING_MIGRATION = '20261017160000_reporting';
const HISTORICAL_TABLES = [
  'auth_identity',
  'country',
  'route',
  'route_version',
  'trip',
  'passenger_manifest',
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

describe('upgrade from a real PR-15 database', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let t: TestApp;
  let workDir: string;
  let url: string;
  let before: Record<string, string | null>;
  const name = `et_pr15_${randomBytes(6).toString('hex')}`;

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  const snapshot = async () => {
    const rows: Array<readonly [string, string | null]> = [];
    for (const table of HISTORICAL_TABLES) {
      const historicalJson =
        table === 'trip'
          ? "to_jsonb(x) - ARRAY['actual_departure_at', 'actual_arrival_at', 'departure_authorization_id', 'support_vehicle_id']"
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

    workDir = mkdtempSync(join(tmpdir(), 'et-pr15-upgrade-'));
    const pr15 = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= PR15_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(pr15, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: pr15 },
        datasource: { url },
      })};\n`,
    );
    deploy(config, url);
    raw = createDatabaseClient({ databaseUrl: url });
    expect(await applied()).toHaveLength(15);
    expect((await applied()).at(-1)).toBe(PR15_MIGRATION);

    t = await startTestApp(integrationEnv({ DATABASE_URL: url }));
    const generator = await createIdentity(t.app, { realm: 'staff' });
    const fixture = await bookableFixture(t.app);
    await db(t.app).passengerManifest.create({
      data: {
        reference: generateManifestReference(),
        tripId: fixture.tripId,
        version: 1,
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        contentHash: 'a'.repeat(64),
        passengerCount: 0,
        boardedCount: 0,
        snapshot: {
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          trip: { reference: fixture.tripReference },
          passengers: [],
        },
        generatedByIdentityId: generator.id,
      },
    });
    before = await snapshot();

    deploy(null, url);
  }, 120_000);

  afterAll(async () => {
    await t?.app.close();
    await raw?.$disconnect();
    if (root) {
      await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await root.$disconnect();
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('applies only PR-16, preserves PR-15 rows and backfills no permit', async () => {
    const migrations = await applied();
    expect(migrations).toEqual(CURRENT_MIGRATIONS);
    expect(migrations).toContain(REPORTING_MIGRATION);
    expect(await snapshot()).toEqual(before);

    const [permitCount, permissionCount, grantCount] = await Promise.all([
      raw.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT count(*) AS count FROM "regulatory_permit"',
      ),
      raw.$queryRawUnsafe<Array<{ count: bigint }>>(
        "SELECT count(*) AS count FROM authorization_permission WHERE key LIKE 'permit.%'",
      ),
      raw.$queryRawUnsafe<Array<{ count: bigint }>>(
        "SELECT count(*) AS count FROM authorization_role_permission WHERE permission_key LIKE 'permit.%'",
      ),
    ]);
    expect(Number(permitCount[0]!.count)).toBe(0);
    expect(Number(permissionCount[0]!.count)).toBe(2);
    expect(Number(grantCount[0]!.count)).toBe(9);
    expect(
      await raw.passengerManifest.count({ where: { schemaVersion: MANIFEST_SCHEMA_VERSION } }),
    ).toBe(1);
  });

  it('is idempotent under a second deploy and reports all 23 migrations applied', async () => {
    deploy(null, url);
    expect(await applied()).toEqual(CURRENT_MIGRATIONS);
    const status = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(status).toContain('Database schema is up to date');
  });
});
