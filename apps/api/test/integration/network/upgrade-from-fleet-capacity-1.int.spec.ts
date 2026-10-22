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

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

describe('upgrade from FLEET-CAPACITY-1 to TERANGA-STOPS-1 (isolated database)', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let url: string;
  let workDir: string;
  const name = `et_teranga_stops_${randomBytes(6).toString('hex')}`;
  const borderId = '01900000-0000-7000-8000-000000000301';
  const technicalId = '01900000-0000-7000-8000-000000000302';
  const countryId = '01900000-0000-7000-8000-000000000303';

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  beforeAll(async () => {
    expect(CURRENT_MIGRATIONS).toContain(TERANGA_STOPS_MIGRATION);
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-teranga-stops-upgrade-'));
    const beforeMigrations = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry < TERANGA_STOPS_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(beforeMigrations, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: beforeMigrations },
        datasource: { url },
      })};\n`,
    );
    deploy(config, url);
    raw = createDatabaseClient({ databaseUrl: url });

    await raw.$executeRawUnsafe(`
      INSERT INTO country (id, iso2, iso3, name, active, created_at, updated_at)
      VALUES ('${countryId}', 'XZ', 'XZZ', 'Upgrade synthetic', true, now(), now())
    `);
    await raw.$executeRawUnsafe(`
      INSERT INTO checkpoint (
        id, code, name, country_id, type, locality, latitude, longitude, timezone,
        active, created_at, updated_at
      ) VALUES
      (
        '${borderId}', 'UPGRADE_BORDER', 'Existing border', '${countryId}',
        'BORDER', 'Border locality', 1, 1, 'Etc/UTC', true, now(), now()
      ),
      (
        '${technicalId}', 'UPGRADE_TECH', 'Existing technical point', '${countryId}',
        'TECHNICAL', 'Technical locality', 2, 2, 'Etc/UTC', true, now(), now()
      )
    `);

    deploy(null, url);
  }, 60_000);

  afterAll(async () => {
    await raw?.$disconnect();
    await root?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root?.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('preserves previous public visibility and assigns safe operational defaults', async () => {
    const rows = await raw.$queryRawUnsafe<
      Array<{
        code: string;
        teranga_kind: string;
        traveller_visible: boolean;
        suggested_dwell_minutes: number | null;
        facilities: string[];
      }>
    >(`
      SELECT code, teranga_kind::text, traveller_visible, suggested_dwell_minutes,
             facilities::text[]
      FROM checkpoint
      WHERE id IN ('${borderId}', '${technicalId}')
      ORDER BY code
    `);
    expect(rows).toEqual([
      {
        code: 'UPGRADE_BORDER',
        teranga_kind: 'BORDER',
        traveller_visible: true,
        suggested_dwell_minutes: null,
        facilities: [],
      },
      {
        code: 'UPGRADE_TECH',
        teranga_kind: 'TECHNICAL',
        traveller_visible: false,
        suggested_dwell_minutes: null,
        facilities: [],
      },
    ]);
    expect(await applied()).toEqual(CURRENT_MIGRATIONS);
  });

  it('is idempotent and reports the complete migration history', async () => {
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
