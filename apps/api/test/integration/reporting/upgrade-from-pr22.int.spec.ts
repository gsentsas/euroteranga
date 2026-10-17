import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const PR22_MIGRATION = '20261017143000_finance';
const PR23_MIGRATION = '20261017160000_reporting';

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

describe('upgrade from a real PR-22 database', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let workDir: string;
  let url: string;
  const name = 'et_pr22_' + randomBytes(6).toString('hex');
  const tripRevenueId = '01900000-0000-7000-8000-000000000399';
  const tripId = '01900000-0000-7000-8000-000000000398';
  const identityId = '01900000-0000-7000-8000-000000000397';

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');

    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe('CREATE DATABASE "' + name + '"');
    const target = new URL(base);
    target.pathname = '/' + name;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-pr22-reporting-upgrade-'));
    const historicalMigrations = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= PR22_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(historicalMigrations, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      'export default ' +
        JSON.stringify({
          schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
          migrations: { path: historicalMigrations },
          datasource: { url },
        }) +
        ';' +
        String.fromCharCode(10),
    );
    deploy(config, url);

    raw = createDatabaseClient({ databaseUrl: url });
    expect(await applied()).toHaveLength(22);
    expect((await applied()).at(-1)).toBe(PR22_MIGRATION);

    // Preserve a real PR-22 finance row through the catalogue-only PR-23 migration.
    await raw.$executeRawUnsafe(
      `INSERT INTO "auth_identity" ("id","realm","email","normalized_email","status","created_at","updated_at") VALUES ($1::uuid,'STAFF','upgrade.pr23@example.test','upgrade.pr23@example.test','ACTIVE',now(),now())`,
      identityId,
    );
    await raw.$executeRawUnsafe(
      `INSERT INTO "route" ("id","code","name","active","created_at","updated_at") VALUES ('01900000-0000-7000-8000-000000000391'::uuid,'UP23','Upgrade PR23',true,now(),now())`,
    );
    await raw.$executeRawUnsafe(
      `INSERT INTO "route_version" ("id","route_id","version","status","published_at","created_at","updated_at") VALUES ('01900000-0000-7000-8000-000000000392'::uuid,'01900000-0000-7000-8000-000000000391'::uuid,1,'PUBLISHED',now(),now(),now())`,
    );
    await raw.$executeRawUnsafe(
      `INSERT INTO "trip" ("id","reference","route_version_id","status","planned_departure_at","planned_arrival_at","created_at","updated_at") VALUES ($1::uuid,'ET-UPGRADE-PR23','01900000-0000-7000-8000-000000000392'::uuid,'DRAFT',now()+interval '1 day',now()+interval '2 days',now(),now())`,
      tripId,
    );
    await raw.$executeRawUnsafe(
      `INSERT INTO "trip_revenue" ("id","reference","trip_id","type","status","amount_minor","currency_code","currency_minor_unit","description","occurred_at","created_by_identity_id","created_at") VALUES ($1::uuid,'ETFR-000000000023',$2::uuid,'OTHER','ACTIVE',12345,'EUR',2,'Upgrade PR23 preserved row',now(),$3::uuid,now())`,
      tripRevenueId,
      tripId,
      identityId,
    );

    deploy(null, url);
  }, 120_000);

  afterAll(async () => {
    await raw?.$disconnect();
    if (root) {
      await root.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      await root.$disconnect();
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('applies only PR-23 and preserves PR-22 finance data', async () => {
    expect(await applied()).toHaveLength(23);
    expect((await applied()).at(-1)).toBe(PR23_MIGRATION);
    const revenue = await raw.tripRevenue.findUniqueOrThrow({
      where: { id: tripRevenueId },
      select: { amountMinor: true, currencyCode: true, status: true },
    });
    expect(revenue).toEqual({ amountMinor: 12345n, currencyCode: 'EUR', status: 'ACTIVE' });
  });

  it('seeds exactly the reporting catalogue and default grants', async () => {
    const permissions = await raw.authorizationPermission.findMany({
      where: { key: { in: ['reporting.view', 'reporting.export'] } },
      orderBy: { key: 'asc' },
      select: { key: true },
    });
    expect(permissions.map((permission) => permission.key)).toEqual([
      'reporting.export',
      'reporting.view',
    ]);

    const grants = await raw.authorizationRolePermission.findMany({
      where: { permissionKey: { in: ['reporting.view', 'reporting.export'] } },
      orderBy: [{ permissionKey: 'asc' }, { roleKey: 'asc' }],
      select: { permissionKey: true, roleKey: true },
    });
    expect(grants).toEqual([
      { permissionKey: 'reporting.export', roleKey: 'AUDITOR' },
      { permissionKey: 'reporting.export', roleKey: 'DIRECTOR' },
      { permissionKey: 'reporting.export', roleKey: 'OPS_MANAGER' },
      { permissionKey: 'reporting.export', roleKey: 'SUPER_ADMIN' },
      { permissionKey: 'reporting.view', roleKey: 'AUDITOR' },
      { permissionKey: 'reporting.view', roleKey: 'DIRECTOR' },
      { permissionKey: 'reporting.view', roleKey: 'OPS_MANAGER' },
      { permissionKey: 'reporting.view', roleKey: 'SUPER_ADMIN' },
    ]);
  });

  it('is idempotent and reports all 23 migrations applied', async () => {
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
