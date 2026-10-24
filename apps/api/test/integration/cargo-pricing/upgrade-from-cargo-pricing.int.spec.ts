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
const PREVIOUS_MIGRATION = '20261023110000_teranga_comfort_1';
const CARGO_PRICING_MIGRATION = '20261024124000_cargo_pricing_1';
const STAFF_ID = '01900000-0000-7000-8000-00000000d101';
const SHIPMENT_ID = '01900000-0000-7000-8000-00000000d102';
const QUOTE_ID = '01900000-0000-7000-8000-00000000d103';
const LINE_ID = '01900000-0000-7000-8000-00000000d104';

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

describe('upgrade from the pre-Cargo-Pricing stack (isolated database)', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let url: string;
  let workDir: string;
  const name = `et_cargo_pricing_${randomBytes(6).toString('hex')}`;

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  beforeAll(async () => {
    expect(CURRENT_MIGRATIONS.at(-1)).toBe(CARGO_PRICING_MIGRATION);
    expect(CURRENT_MIGRATIONS.indexOf(CARGO_PRICING_MIGRATION)).toBeGreaterThan(
      CURRENT_MIGRATIONS.indexOf(PREVIOUS_MIGRATION),
    );
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-cargo-pricing-upgrade-'));
    const previous = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= PREVIOUS_MIGRATION) {
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
    expect((await applied()).at(-1)).toBe(PREVIOUS_MIGRATION);

    await raw.$executeRawUnsafe(`
      INSERT INTO auth_identity (
        id, realm, email, normalized_email, status, email_verified_at, updated_at
      ) VALUES (
        '${STAFF_ID}', 'STAFF', 'cargo.pricing.upgrade@example.test',
        'cargo.pricing.upgrade@example.test', 'ACTIVE', now(), now()
      );

      INSERT INTO road_freight_shipment (
        id, reference, direction,
        sender_name, sender_contact, recipient_name, recipient_contact,
        weight_kg, volume_liters, package_count, declared_contents,
        fragile, professional, pickup_required, delivery_required,
        lifecycle_status, created_at, updated_at
      ) VALUES (
        '${SHIPMENT_ID}', 'ETC-ABCDEFGHJKMN', 'PAR_DKR',
        'Expéditeur historique', 'contact-historique',
        'Destinataire historique', 'recipient-historique',
        25.000, 96, 1, 'Fret historique',
        false, false, false, false,
        'QUOTE', now(), now()
      );

      INSERT INTO road_freight_shipment_event (
        id, shipment_id, sequence, type, lifecycle_status,
        occurred_at, actor_identity_id, payload_fingerprint
      )
      SELECT
        gen_random_uuid(), s.id, 1, 'QUOTE', 'QUOTE',
        s.created_at, '${STAFF_ID}', repeat('a', 64)
      FROM road_freight_shipment s WHERE s.id = '${SHIPMENT_ID}';

      INSERT INTO road_freight_quote (
        id, reference, shipment_id, version, status,
        currency_code, currency_minor_unit,
        snapshot_direction, snapshot_weight_kg, snapshot_volume_liters,
        snapshot_package_count, snapshot_fragile, snapshot_professional,
        snapshot_pickup_required, snapshot_delivery_required,
        shipment_updated_at, created_by_identity_id, updated_at
      )
      SELECT
        '${QUOTE_ID}', 'ETCQ-ABCDEFGHJKMN', s.id, 1, 'DRAFT',
        'EUR', 2, s.direction, s.weight_kg, s.volume_liters,
        s.package_count, s.fragile, s.professional,
        s.pickup_required, s.delivery_required,
        s.updated_at, '${STAFF_ID}', now()
      FROM road_freight_shipment s WHERE s.id = '${SHIPMENT_ID}';

      INSERT INTO road_freight_quote_line (
        id, quote_id, kind, label, amount_minor, position
      ) VALUES (
        '${LINE_ID}', '${QUOTE_ID}', 'CHARGE', 'Ligne historique synthétique', 12550, 0
      );
    `);

    deploy(null, url);
  }, 60_000);

  afterAll(async () => {
    await raw?.$disconnect();
    await root?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root?.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('preserves every existing freight and quote row and seeds no tariff', async () => {
    const [snapshot] = await raw.$queryRawUnsafe<
      Array<{
        shipment_count: bigint;
        quote_count: bigint;
        line_count: bigint;
        amount_minor: bigint;
      }>
    >(`
      SELECT
        (SELECT count(*) FROM road_freight_shipment) AS shipment_count,
        (SELECT count(*) FROM road_freight_quote) AS quote_count,
        (SELECT count(*) FROM road_freight_quote_line) AS line_count,
        (SELECT amount_minor FROM road_freight_quote_line WHERE id = '${LINE_ID}') AS amount_minor
    `);
    expect(snapshot).toEqual({
      shipment_count: 1n,
      quote_count: 1n,
      line_count: 1n,
      amount_minor: 12550n,
    });
    expect(
      Number(
        (
          await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
            'SELECT count(*) AS count FROM cargo_pricing_rule',
          )
        )[0]!.count,
      ),
    ).toBe(0);
    expect(await applied()).toEqual(CURRENT_MIGRATIONS);
  });

  it('deploys a second time and reports no migration drift', async () => {
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
