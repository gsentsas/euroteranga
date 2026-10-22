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
const CAPACITY_MIGRATION = '20261021210000_vehicle_capacity';

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

describe('upgrade from FLEET-MEDIA-1 to vehicle capacity (isolated database)', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let url: string;
  let workDir: string;
  const name = `et_fleet_capacity_${randomBytes(6).toString('hex')}`;
  const vehicleId = '01900000-0000-7000-8000-000000000201';

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  beforeAll(async () => {
    expect(CURRENT_MIGRATIONS).toContain(CAPACITY_MIGRATION);
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-fleet-capacity-upgrade-'));
    const beforeMigrations = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry < CAPACITY_MIGRATION) {
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
      INSERT INTO vehicle (
        id, code, manufacturer, model, status, amenities, created_at, updated_at
      ) VALUES (
        '${vehicleId}', 'UPGRADE_CAPACITY_COACH', 'Constructeur historique',
        'Modèle historique', 'PLANNED', ARRAY['WIFI']::vehicle_amenity[], now(), now()
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

  it('keeps the existing vehicle and initializes safe capacity defaults', async () => {
    const rows = await raw.$queryRawUnsafe<
      Array<{
        code: string;
        role: string;
        payload_capacity_kg: number | null;
        cargo_volume_liters: number | null;
      }>
    >(`
      SELECT code, role::text, payload_capacity_kg, cargo_volume_liters
      FROM vehicle WHERE id = '${vehicleId}'
    `);
    expect(rows).toEqual([
      {
        code: 'UPGRADE_CAPACITY_COACH',
        role: 'PASSENGER_COACH',
        payload_capacity_kg: null,
        cargo_volume_liters: null,
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
