import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiEnv } from '@euroteranga/config';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { complianceApi } from '../../support/compliance-helpers.js';
import {
  confirmedBooking,
  createPassenger,
  uploadDocument,
} from '../../support/passenger-document-helpers.js';
import { paymentApi, settle } from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const PASSENGER_DOCUMENT_MIGRATION = '20261014010000_passenger_documents';
const COMPLIANCE_MIGRATION = '20261014120000_compliance';
const FINANCE_MIGRATION = '20261017143000_finance';
const COMPLIANCE_TABLES = [
  'compliance_rule',
  'compliance_rule_version',
  'compliance_evaluation',
  'compliance_evaluation_result',
  'compliance_evaluation_evidence',
  'compliance_review',
];

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

/** A real PR-11 database is populated through the API before only PR-12 runs. */
describe('upgrade from a PR-11 database (isolated database)', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let bookingReference: string;
  let passengerReference: string;
  let url: string;
  let workDir: string;
  let storageRoot: string;
  let before: Record<string, string | null>;
  let afterCompliance: {
    applied: string[];
    snapshot: Record<string, string | null>;
    counts: number[];
  };
  const name = `et_pr11_${randomBytes(6).toString('hex')}`;

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

  /** Full rows (every column) of each PR-10/PR-11 table the migration must not touch. */
  const snapshot = async () => {
    const tables = [
      'booking',
      'booking_seat',
      'seat_inventory_lock',
      'payment',
      'payment_event',
      'passenger',
      'booking_passenger',
      'passenger_document',
    ];
    return Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => {
          const order = table === 'booking_passenger' ? 'x.booking_id, x.passenger_id' : 'x.id';
          const [row] = await raw.$queryRawUnsafe<Array<{ value: string | null }>>(
            `SELECT jsonb_agg(to_jsonb(x) ORDER BY ${order})::text AS value FROM (SELECT * FROM "${table}") x`,
          );
          return [table, row!.value] as const;
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

    workDir = mkdtempSync(join(tmpdir(), 'et-pr11-upgrade-'));
    storageRoot = mkdtempSync(join(tmpdir(), 'et-pr11-documents-'));
    const pr11 = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= PASSENGER_DOCUMENT_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(pr11, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: pr11 },
        datasource: { url },
      })};\n`,
    );
    deploy(config, url);
    raw = createDatabaseClient({ databaseUrl: url });
    expect(await applied()).toHaveLength(11);

    env = integrationEnv({ DATABASE_URL: url, OBJECT_STORAGE_LOCAL_ROOT: storageRoot });
    t = await startTestApp(env);
    customer = await customerActor(t.app);
    const confirmed = await confirmedBooking(t.app, env, customer, ['1A', '1B']);
    bookingReference = confirmed.reference;
    const passenger = await createPassenger(
      customer,
      bookingReference,
      confirmed.fixture.countryId,
    );
    if (passenger.status !== 201) throw new Error(`passenger fixture failed: ${passenger.text}`);
    passengerReference = passenger.body.reference as string;
    const document = await uploadDocument(t.app, customer, passengerReference, {
      expiresAt: '2040-01-01',
    });
    if (document.status !== 201) throw new Error(`document fixture failed: ${document.text}`);

    // Other PR-10 states: a failed attempt with its event, a PENDING retry,
    // a customer-cancelled hold.
    const fixture = await bookableFixture(t.app, { amount: () => 1_250 });
    const retried = await bookingApi(customer).post('/bookings', holdBody(fixture, 1, 3, ['2A']));
    const failed = await paymentApi(customer).create(retried.body.reference as string);
    await settle(t.app, env, failed.body.payment, 'payment.failed');
    await paymentApi(customer).create(retried.body.reference as string);
    const cancelled = await bookingApi(customer).post('/bookings', holdBody(fixture, 2, 4, ['2B']));
    await bookingApi(customer).post(`/bookings/${cancelled.body.reference}/cancel`);

    before = await snapshot();
    // PR-12 alone first, measured on its own; then the real directory (PR-13
    // and any later additive migration).
    const pr12 = join(workDir, 'migrations-pr12');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= COMPLIANCE_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(pr12, entry), { recursive: true });
      }
    }
    const pr12Config = join(workDir, 'prisma.pr12.config.mjs');
    writeFileSync(
      pr12Config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: pr12 },
        datasource: { url },
      })};\n`,
    );
    deploy(pr12Config, url);
    afterCompliance = {
      applied: await applied(),
      snapshot: await snapshot(),
      counts: await Promise.all(COMPLIANCE_TABLES.map((table) => count(table))),
    };
    deploy(null, url);
    // Three `prisma migrate deploy` processes now, as in the PR-10 upgrade test.
  }, 60_000);

  afterAll(async () => {
    await t?.app.close();
    await raw?.$disconnect();
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('applies only PR-12, keeps every PR-10/PR-11 row identical and backfills nothing', async () => {
    expect(afterCompliance.applied).toHaveLength(12);
    expect(afterCompliance.applied.at(-1)).toBe(COMPLIANCE_MIGRATION);
    expect(afterCompliance.snapshot).toEqual(before);
    expect(afterCompliance.counts).toEqual(COMPLIANCE_TABLES.map(() => 0));
    // Still true once the later migrations are applied.
    const migrations = await applied();
    expect(migrations).toHaveLength(22);
    expect(migrations.at(-1)).toBe(FINANCE_MIGRATION);
    const rows = (value: string | null) =>
      JSON.parse(value ?? '[]') as Array<Record<string, unknown>>;
    expect(rows(before.passenger!)).toHaveLength(1);
    expect(rows(before.booking_passenger!)).toHaveLength(1);
    expect(rows(before.passenger_document!).map((row) => row.status)).toEqual(['ACCEPTED']);
    expect(
      rows(before.payment!)
        .map((row) => row.status)
        .sort(),
    ).toEqual(['FAILED', 'PENDING', 'SUCCEEDED']);
    expect(rows(before.booking!).filter((row) => row.cancelled_at !== null)).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
    for (const table of COMPLIANCE_TABLES) expect(await count(table), table).toBe(0);
    expect(
      Number(
        (
          await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
            "SELECT count(*) AS count FROM authorization_permission WHERE key LIKE 'compliance.%'",
          )
        )[0]!.count,
      ),
    ).toBe(4);
  });

  it('lets the historical booking passenger be evaluated, without rules never as compliant', async () => {
    const evaluated = await complianceApi(customer).evaluate(bookingReference, passengerReference);
    expect(evaluated.status).toBe(200);
    expect(evaluated.body).toMatchObject({
      status: 'REVIEW_REQUIRED',
      evaluation: { result: 'REVIEW_REQUIRED', current: true },
      findings: expect.arrayContaining([{ code: 'NO_APPLICABLE_RULE' }]),
    });
    expect(await count('compliance_evaluation')).toBe(1);
  });

  it('is idempotent under a second migrate deploy and reports an up-to-date schema', async () => {
    deploy(null, url);
    const status = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(status).toContain('Database schema is up to date');
    expect(await applied()).toHaveLength(22);
  });
});
