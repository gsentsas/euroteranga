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
const FLEET_MEDIA_MIGRATION = '20261021090000_vehicle_media';

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

/** Upgrade the exact pre-FLEET-MEDIA-1 schema with existing fleet/media rows. */
describe('upgrade to vehicle media (isolated database)', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let url: string;
  let workDir: string;
  const name = `et_fleet_media_${randomBytes(6).toString('hex')}`;
  const vehicleId = '01900000-0000-7000-8000-000000000101';
  const mediaId = '01900000-0000-7000-8000-000000000102';

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  beforeAll(async () => {
    expect(CURRENT_MIGRATIONS).toContain(FLEET_MEDIA_MIGRATION);
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-fleet-media-upgrade-'));
    const beforeMigrations = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry < FLEET_MEDIA_MIGRATION) {
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
        '${vehicleId}', 'UPGRADE_COACH', 'Constructeur historique', 'Modèle historique',
        'PLANNED', ARRAY['WIFI']::vehicle_amenity[], now(), now()
      )
    `);
    const source = randomBytes(32).toString('hex');
    await raw.$executeRawUnsafe(`
      INSERT INTO public_media_asset (
        id, alt_text, source_format, source_sha256, source_bytes, width, height,
        created_at, updated_at
      ) VALUES (
        '${mediaId}', 'Photo historique', 'jpeg', '${source}', 1024, 1200, 800, now(), now()
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

  it('preserves existing rows and initializes nullable/empty media relations', async () => {
    const vehicles = await raw.$queryRawUnsafe<
      Array<{
        code: string;
        manufacturer: string;
        model: string;
        amenities: string[];
        primary_media_id: string | null;
      }>
    >(`SELECT code, manufacturer, model, amenities::text[], primary_media_id
       FROM vehicle WHERE id = '${vehicleId}'`);
    expect(vehicles).toEqual([
      {
        code: 'UPGRADE_COACH',
        manufacturer: 'Constructeur historique',
        model: 'Modèle historique',
        amenities: ['WIFI'],
        primary_media_id: null,
      },
    ]);
    expect(
      await raw.$queryRawUnsafe(
        `SELECT id, alt_text FROM public_media_asset WHERE id = '${mediaId}'`,
      ),
    ).toEqual([{ id: mediaId, alt_text: 'Photo historique' }]);
    expect(await raw.vehicleMedia.count()).toBe(0);
    const grants = await raw.$queryRawUnsafe<Array<{ count: bigint }>>(`
      SELECT count(*) AS count FROM authorization_role_permission
      WHERE role_key = 'OPS_MANAGER' AND permission_key = 'media.read'
    `);
    expect(Number(grants[0]!.count)).toBe(1);
    expect(await applied()).toEqual(CURRENT_MIGRATIONS);
  });

  it('is idempotent and reports no migration drift', async () => {
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
