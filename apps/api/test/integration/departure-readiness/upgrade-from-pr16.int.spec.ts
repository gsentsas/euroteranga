import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePermitReference } from '../../../src/regulatory-permits/regulatory-permit-rules.js';
import { createIdentity, db } from '../../support/auth-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const PR16_MIGRATION = '20261015120000_regulatory_permits';
const INCIDENT_MIGRATION = '20261017083000_incidents';
const HISTORICAL_TABLES = ['auth_identity', 'regulatory_permit'] as const;

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

describe('upgrade from a real PR-16 database', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let t: TestApp;
  let workDir: string;
  let url: string;
  let before: Record<string, string | null>;
  const name = `et_pr16_${randomBytes(6).toString('hex')}`;

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  const snapshot = async () => {
    const rows: Array<readonly [string, string | null]> = [];
    for (const table of HISTORICAL_TABLES) {
      const [row] = await raw.$queryRawUnsafe<Array<{ value: string | null }>>(
        `SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x))::text AS value FROM (SELECT * FROM "${table}") x`,
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

    workDir = mkdtempSync(join(tmpdir(), 'et-pr16-upgrade-'));
    const pr16 = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= PR16_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(pr16, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: pr16 },
        datasource: { url },
      })};\n`,
    );
    deploy(config, url);
    raw = createDatabaseClient({ databaseUrl: url });
    expect(await applied()).toHaveLength(16);
    expect((await applied()).at(-1)).toBe(PR16_MIGRATION);

    t = await startTestApp(integrationEnv({ DATABASE_URL: url }));
    const creator = await createIdentity(t.app, { realm: 'staff' });
    await db(t.app).regulatoryPermit.create({
      data: {
        reference: generatePermitReference(),
        permitType: 'SYNTHETIC_UPGRADE',
        title: 'Autorisation synthétique historique',
        issuingAuthority: 'Autorité synthétique',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validUntil: new Date('2030-12-31T00:00:00.000Z'),
        status: 'DRAFT',
        scopeType: 'OPERATOR',
        createdByIdentityId: creator.id,
        updatedByIdentityId: creator.id,
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

  it('applies only PR-17, preserves PR-16 rows and backfills no readiness fact', async () => {
    const migrations = await applied();
    expect(migrations).toHaveLength(21);
    expect(migrations.at(-1)).toBe(INCIDENT_MIGRATION);
    expect(await snapshot()).toEqual(before);

    const [policyCount, requirementCount, authorizationCount, permissionCount, grantCount] =
      await Promise.all([
        raw.departurePermitPolicy.count(),
        raw.departurePermitRequirement.count(),
        raw.departureAuthorization.count(),
        raw.$queryRawUnsafe<Array<{ count: bigint }>>(
          "SELECT count(*) AS count FROM authorization_permission WHERE key LIKE 'departure.%'",
        ),
        raw.$queryRawUnsafe<Array<{ count: bigint }>>(
          "SELECT count(*) AS count FROM authorization_role_permission WHERE permission_key LIKE 'departure.%'",
        ),
      ]);
    expect(policyCount).toBe(0);
    expect(requirementCount).toBe(0);
    expect(authorizationCount).toBe(0);
    expect(Number(permissionCount[0]!.count)).toBe(3);
    expect(Number(grantCount[0]!.count)).toBe(13);

    const statuses = await raw.$queryRawUnsafe<Array<{ value: string }>>(
      'SELECT unnest(enum_range(NULL::trip_status))::text AS value ORDER BY 1',
    );
    expect(statuses.map((row) => row.value)).toEqual(
      expect.arrayContaining(['DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
    );
    expect(await raw.regulatoryPermit.count({ where: { permitType: 'SYNTHETIC_UPGRADE' } })).toBe(
      1,
    );
  });

  it('is idempotent under a second deploy and reports all 21 migrations applied', async () => {
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
