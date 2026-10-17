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
const PR20_MIGRATION = '20261017013000_borders';
const PR21_MIGRATION = '20261017083000_incidents';

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

describe('upgrade from a real PR-20 database', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let workDir: string;
  let url: string;
  const name = 'et_pr20_' + randomBytes(6).toString('hex');
  const markerIso2 = 'Q' + String.fromCharCode(65 + (randomBytes(1)[0]! % 26));
  const markerIso3 = markerIso2 + String.fromCharCode(65 + (randomBytes(1)[0]! % 26));

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

    workDir = mkdtempSync(join(tmpdir(), 'et-pr20-upgrade-'));
    const historicalMigrations = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= PR20_MIGRATION) {
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
        ';\n',
    );
    deploy(config, url);

    raw = createDatabaseClient({ databaseUrl: url });
    expect(await applied()).toHaveLength(20);
    expect((await applied()).at(-1)).toBe(PR20_MIGRATION);

    const before = await raw.$queryRawUnsafe<Array<{ incident: string | null }>>(
      "SELECT to_regclass('public.incident')::text AS incident",
    );
    expect(before[0]?.incident).toBeNull();

    await raw.country.create({
      data: {
        iso2: markerIso2,
        iso3: markerIso3,
        name: 'PR20 historical marker',
      },
    });

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

  it('applies only PR-21 on top of PR-20 without synthesizing incident history', async () => {
    expect(await applied()).toHaveLength(21);
    expect((await applied()).at(-1)).toBe(PR21_MIGRATION);

    expect(
      await raw.country.count({
        where: { iso2: markerIso2, iso3: markerIso3, name: 'PR20 historical marker' },
      }),
    ).toBe(1);
    expect(await raw.incident.count()).toBe(0);
    expect(await raw.incidentAction.count()).toBe(0);
    expect(await raw.incidentAttachment.count()).toBe(0);

    const tables = await raw.$queryRawUnsafe<Array<{ table_name: string }>>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'incident%' ORDER BY table_name",
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      'incident',
      'incident_action',
      'incident_attachment',
    ]);
  });

  it('seeds exact incident permissions and role grants', async () => {
    const permissions = await raw.authorizationPermission.findMany({
      where: { key: { in: ['incident.read', 'incident.manage', 'crew.incident.report'] } },
      orderBy: { key: 'asc' },
      select: { key: true },
    });
    expect(permissions.map((permission) => permission.key)).toEqual([
      'crew.incident.report',
      'incident.manage',
      'incident.read',
    ]);

    const grants = await raw.authorizationRolePermission.findMany({
      where: {
        permissionKey: { in: ['incident.read', 'incident.manage', 'crew.incident.report'] },
      },
      orderBy: [{ permissionKey: 'asc' }, { roleKey: 'asc' }],
      select: { permissionKey: true, roleKey: true },
    });
    expect(grants).toEqual([
      { permissionKey: 'crew.incident.report', roleKey: 'CREW' },
      { permissionKey: 'crew.incident.report', roleKey: 'DRIVER' },
      { permissionKey: 'crew.incident.report', roleKey: 'SUPER_ADMIN' },
      { permissionKey: 'incident.manage', roleKey: 'DIRECTOR' },
      { permissionKey: 'incident.manage', roleKey: 'DISPATCHER' },
      { permissionKey: 'incident.manage', roleKey: 'OPS_MANAGER' },
      { permissionKey: 'incident.manage', roleKey: 'SUPER_ADMIN' },
      { permissionKey: 'incident.read', roleKey: 'AUDITOR' },
      { permissionKey: 'incident.read', roleKey: 'CUSTOMER_SUPPORT' },
      { permissionKey: 'incident.read', roleKey: 'DIRECTOR' },
      { permissionKey: 'incident.read', roleKey: 'DISPATCHER' },
      { permissionKey: 'incident.read', roleKey: 'OPS_MANAGER' },
      { permissionKey: 'incident.read', roleKey: 'SUPER_ADMIN' },
    ]);
  });

  it('is idempotent and reports all 21 migrations applied', async () => {
    deploy(null, url);
    expect(await applied()).toHaveLength(21);
    const status = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(status).toContain('Database schema is up to date');
  });
});
