import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiEnv } from '@euroteranga/config';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CustomerActor } from '../../support/booking-helpers.js';
import { customerActor } from '../../support/booking-helpers.js';
import {
  confirmedBooking,
  createPassenger,
  uploadDocument,
} from '../../support/passenger-document-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const PAYMENT_MIGRATION = '20261013230000_payments';
const PASSENGER_DOCUMENT_MIGRATION = '20261014010000_passenger_documents';

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

/** A real PR-10 database is populated before only the PR-11 migration runs. */
describe('upgrade from a PR-10 database (isolated database)', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let bookingReference: string;
  let countryId: string;
  let url: string;
  let workDir: string;
  let storageRoot: string;
  let before: Record<string, string | null>;
  const name = `et_pr10_${randomBytes(6).toString('hex')}`;

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  const count = async (table: string) =>
    Number(
      (
        await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*) AS count FROM "${table}"`,
        )
      )[0]!.count,
    );

  const snapshot = async () => {
    const queries = {
      bookings:
        'SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)::text AS value FROM (SELECT * FROM booking) x',
      seats:
        'SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)::text AS value FROM (SELECT * FROM booking_seat) x',
      locks:
        'SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)::text AS value FROM (SELECT * FROM seat_inventory_lock) x',
      payments:
        'SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)::text AS value FROM (SELECT * FROM payment) x',
      paymentEvents:
        'SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)::text AS value FROM (SELECT * FROM payment_event) x',
      confirmations:
        "SELECT jsonb_agg(jsonb_build_object('id', id, 'confirmed_at', confirmed_at) ORDER BY id)::text AS value FROM booking",
    };
    return Object.fromEntries(
      await Promise.all(
        Object.entries(queries).map(async ([key, sql]) => {
          const [row] = await raw.$queryRawUnsafe<Array<{ value: string | null }>>(sql);
          return [key, row!.value] as const;
        }),
      ),
    );
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-pr10-upgrade-'));
    storageRoot = mkdtempSync(join(tmpdir(), 'et-pr10-documents-'));
    const pr10 = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= PAYMENT_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(pr10, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: pr10 },
        datasource: { url },
      })};\n`,
    );
    deploy(config, url);
    raw = createDatabaseClient({ databaseUrl: url });
    expect(await applied()).toHaveLength(10);

    env = integrationEnv({ DATABASE_URL: url, OBJECT_STORAGE_LOCAL_ROOT: storageRoot });
    t = await startTestApp(env);
    customer = await customerActor(t.app);
    const confirmed = await confirmedBooking(t.app, env, customer, ['1A', '1B']);
    bookingReference = confirmed.reference;
    countryId = confirmed.fixture.countryId;
    before = await snapshot();

    // The real migration directory now has exactly PR-11 pending.
    deploy(null, url);
  });

  afterAll(async () => {
    await t?.app.close();
    await raw?.$disconnect();
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('applies only PR-11 and preserves every PR-10 booking/payment/seat value', async () => {
    const migrations = await applied();
    expect(migrations).toHaveLength(11);
    expect(migrations.at(-1)).toBe(PASSENGER_DOCUMENT_MIGRATION);
    expect(await snapshot()).toEqual(before);
    expect(await count('passenger')).toBe(0);
    expect(await count('booking_passenger')).toBe(0);
    expect(await count('passenger_document')).toBe(0);
    expect(
      await raw.$queryRawUnsafe(
        `SELECT confirmed_at FROM booking WHERE reference = '${bookingReference}'`,
      ),
    ).toEqual([{ confirmed_at: expect.any(Date) }]);
  });

  it('lets the historical confirmed booking use the new passenger/document path', async () => {
    const passenger = await createPassenger(customer, bookingReference, countryId);
    expect(passenger.status).toBe(201);
    const document = await uploadDocument(t.app, customer, passenger.body.reference as string);
    expect(document.status).toBe(201);
    expect(document.body).toMatchObject({ status: 'ACCEPTED' });
    expect(await count('passenger')).toBe(1);
    expect(await count('booking_passenger')).toBe(1);
    expect(await count('passenger_document')).toBe(1);
  });

  it('is idempotent under a second migrate deploy and reports an up-to-date schema', async () => {
    deploy(null, url);
    const status = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(status).toContain('Database schema is up to date');
    expect(await applied()).toHaveLength(11);
  });
});
