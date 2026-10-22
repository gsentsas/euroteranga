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
const CARGO_MIGRATION = '20261022180000_cargo_1';
const CARGO_PRICE_MIGRATION = '20261022200000_cargo_price_1';
const STAFF_ID = '01900000-0000-7000-8000-00000000c881';
const SHIPMENT_ID = '01900000-0000-7000-8000-00000000c882';
const EVENT_ID = '01900000-0000-7000-8000-00000000c883';
const REFERENCE = 'ETC-ABCDEFGHJKMN';

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

describe('upgrade from CARGO-1 to CARGO-PRICE-1 (isolated database)', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let url: string;
  let workDir: string;
  const name = `et_cargo_price_${randomBytes(6).toString('hex')}`;

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  beforeAll(async () => {
    expect(CURRENT_MIGRATIONS).toContain(CARGO_MIGRATION);
    expect(CURRENT_MIGRATIONS).toContain(CARGO_PRICE_MIGRATION);
    expect(CURRENT_MIGRATIONS.indexOf(CARGO_PRICE_MIGRATION)).toBeGreaterThan(
      CURRENT_MIGRATIONS.indexOf(CARGO_MIGRATION),
    );

    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-cargo-price-upgrade-'));
    const previous = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= CARGO_MIGRATION) {
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
    expect((await applied()).at(-1)).toBe(CARGO_MIGRATION);

    await raw.$executeRawUnsafe(`
      INSERT INTO auth_identity (
        id, realm, email, normalized_email, status, email_verified_at, updated_at
      ) VALUES (
        '${STAFF_ID}', 'STAFF', 'cargo.upgrade@example.test',
        'cargo.upgrade@example.test', 'ACTIVE', now(), now()
      );

      INSERT INTO road_freight_shipment (
        id, reference, direction,
        sender_name, sender_contact, recipient_name, recipient_contact,
        weight_kg, volume_liters, package_count, declared_contents,
        fragile, professional, pickup_required, delivery_required,
        lifecycle_status, created_at, updated_at
      ) VALUES (
        '${SHIPMENT_ID}', '${REFERENCE}', 'PAR_DKR',
        'Expéditeur upgrade', 'contact-upgrade',
        'Destinataire upgrade', 'recipient-upgrade',
        125.500, 750, 4, 'Fret historique upgrade',
        false, true, true, false,
        'QUOTE', now(), now()
      );

      INSERT INTO road_freight_shipment_event (
        id, shipment_id, sequence, type, lifecycle_status,
        occurred_at, actor_identity_id, payload_fingerprint
      )
      SELECT
        '${EVENT_ID}', s.id, 1, 'QUOTE', 'QUOTE',
        s.created_at, '${STAFF_ID}', repeat('a', 64)
      FROM road_freight_shipment s
      WHERE s.id = '${SHIPMENT_ID}';
    `);

    deploy(null, url);
  }, 60_000);

  afterAll(async () => {
    await raw?.$disconnect();
    await root?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root?.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('preserves the existing freight record and starts with no quote', async () => {
    const rows = await raw.$queryRawUnsafe<
      Array<{
        reference: string;
        direction: string;
        weight_kg: string;
        volume_liters: number;
        package_count: number;
        lifecycle_status: string;
      }>
    >(`
      SELECT
        reference,
        direction::text AS direction,
        weight_kg::text AS weight_kg,
        volume_liters,
        package_count,
        lifecycle_status::text AS lifecycle_status
      FROM road_freight_shipment
      WHERE id = '${SHIPMENT_ID}'
    `);
    expect(rows).toEqual([
      {
        reference: REFERENCE,
        direction: 'PAR_DKR',
        weight_kg: '125.500',
        volume_liters: 750,
        package_count: 4,
        lifecycle_status: 'QUOTE',
      },
    ]);
    expect(
      Number(
        (
          await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
            `SELECT count(*) AS count FROM road_freight_quote WHERE shipment_id = '${SHIPMENT_ID}'`,
          )
        )[0]!.count,
      ),
    ).toBe(0);
    expect(await applied()).toEqual(CURRENT_MIGRATIONS);
  });

  it('deploys a second time without migration drift', async () => {
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
