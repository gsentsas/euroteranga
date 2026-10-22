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
const CARGO_PRICE_MIGRATION = '20261022200000_cargo_price_1';
const CARGO_TRACK_MIGRATION = '20261022213000_cargo_track_1';
const STAFF_ID = '01900000-0000-7000-8000-00000000c981';
const SHIPMENT_ID = '01900000-0000-7000-8000-00000000c982';
const EVENT_ID = '01900000-0000-7000-8000-00000000c983';
const QUOTE_ID = '01900000-0000-7000-8000-00000000c984';
const LINE_ID = '01900000-0000-7000-8000-00000000c985';
const REFERENCE = 'ETC-BCDEFGHJKMNP';
const QUOTE_REFERENCE = 'ETCQ-BCDEFGHJKMNP';

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

describe('upgrade from CARGO-PRICE-1 to CARGO-TRACK-1 (isolated database)', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let url: string;
  let workDir: string;
  const name = `et_cargo_track_${randomBytes(6).toString('hex')}`;

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  beforeAll(async () => {
    expect(CURRENT_MIGRATIONS).toContain(CARGO_PRICE_MIGRATION);
    expect(CURRENT_MIGRATIONS).toContain(CARGO_TRACK_MIGRATION);
    expect(CURRENT_MIGRATIONS.indexOf(CARGO_TRACK_MIGRATION)).toBeGreaterThan(
      CURRENT_MIGRATIONS.indexOf(CARGO_PRICE_MIGRATION),
    );

    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-cargo-track-upgrade-'));
    const previous = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= CARGO_PRICE_MIGRATION) {
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
    expect((await applied()).at(-1)).toBe(CARGO_PRICE_MIGRATION);

    await raw.$executeRawUnsafe(`
      INSERT INTO auth_identity (
        id, realm, email, normalized_email, status, email_verified_at, updated_at
      ) VALUES (
        '${STAFF_ID}', 'STAFF', 'cargo.track.upgrade@example.test',
        'cargo.track.upgrade@example.test', 'ACTIVE', now(), now()
      );

      INSERT INTO road_freight_shipment (
        id, reference, direction,
        sender_name, sender_contact, recipient_name, recipient_contact,
        weight_kg, volume_liters, package_count, declared_contents,
        fragile, professional, pickup_required, delivery_required,
        lifecycle_status, created_at, updated_at
      ) VALUES (
        '${SHIPMENT_ID}', '${REFERENCE}', 'PAR_DKR',
        'Expéditeur tracking upgrade', 'contact-upgrade',
        'Destinataire tracking upgrade', 'recipient-upgrade',
        80.250, 420, 3, 'Fret historique tracking upgrade',
        false, true, false, true,
        'QUOTE', now(), now()
      );

      INSERT INTO road_freight_shipment_event (
        id, shipment_id, sequence, type, lifecycle_status,
        occurred_at, actor_identity_id, payload_fingerprint
      )
      SELECT
        '${EVENT_ID}', s.id, 1, 'QUOTE', 'QUOTE',
        s.created_at, '${STAFF_ID}', repeat('b', 64)
      FROM road_freight_shipment s
      WHERE s.id = '${SHIPMENT_ID}';

      INSERT INTO road_freight_quote (
        id, reference, shipment_id, version, status,
        currency_code, currency_minor_unit,
        snapshot_direction, snapshot_weight_kg, snapshot_volume_liters,
        snapshot_package_count, snapshot_fragile, snapshot_professional,
        snapshot_pickup_required, snapshot_delivery_required,
        shipment_updated_at, created_by_identity_id, created_at, updated_at
      )
      SELECT
        '${QUOTE_ID}', '${QUOTE_REFERENCE}', s.id, 1, 'DRAFT',
        'EUR', 2,
        s.direction, s.weight_kg, s.volume_liters,
        s.package_count, s.fragile, s.professional,
        s.pickup_required, s.delivery_required,
        s.updated_at, '${STAFF_ID}', now(), now()
      FROM road_freight_shipment s
      WHERE s.id = '${SHIPMENT_ID}';

      INSERT INTO road_freight_quote_line (
        id, quote_id, kind, label, amount_minor, position, created_at
      ) VALUES (
        '${LINE_ID}', '${QUOTE_ID}', 'CHARGE', 'Transport historique', 17500, 0, now()
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

  it('preserves Cargo and quote history without creating a public capability', async () => {
    const rows = await raw.$queryRawUnsafe<
      Array<{
        reference: string;
        weight_kg: string;
        quote_reference: string;
        amount_minor: string;
      }>
    >(`
      SELECT
        s.reference,
        s.weight_kg::text AS weight_kg,
        q.reference AS quote_reference,
        l.amount_minor::text AS amount_minor
      FROM road_freight_shipment s
      JOIN road_freight_quote q ON q.shipment_id = s.id
      JOIN road_freight_quote_line l ON l.quote_id = q.id
      WHERE s.id = '${SHIPMENT_ID}'
    `);
    expect(rows).toEqual([
      {
        reference: REFERENCE,
        weight_kg: '80.250',
        quote_reference: QUOTE_REFERENCE,
        amount_minor: '17500',
      },
    ]);

    const tokenCount = await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM road_freight_public_token WHERE shipment_id = '${SHIPMENT_ID}'`,
    );
    expect(Number(tokenCount[0]!.count)).toBe(0);
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
