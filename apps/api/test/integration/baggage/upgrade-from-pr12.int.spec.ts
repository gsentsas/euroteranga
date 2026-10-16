import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiEnv } from '@euroteranga/config';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, staffActor, type StaffActor } from '../../support/admin-helpers.js';
import { confirmedPassenger, customerBaggageApi } from '../../support/baggage-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { complianceApi } from '../../support/compliance-helpers.js';
import { uploadDocument } from '../../support/passenger-document-helpers.js';
import { paymentApi, settle } from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const COMPLIANCE_MIGRATION = '20261014120000_compliance';
const BAGGAGE_MIGRATION = '20261014150000_baggage';
const CREW_MIGRATION = '20261016030000_crew_offline';
const HISTORICAL_TABLES = [
  'trip',
  'booking',
  'booking_seat',
  'seat_inventory_lock',
  'payment',
  'payment_event',
  'passenger',
  'booking_passenger',
  'passenger_document',
  'compliance_rule',
  'compliance_rule_version',
  'compliance_evaluation',
  'compliance_evaluation_result',
  'compliance_evaluation_evidence',
  'compliance_review',
  'audit_event',
] as const;

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

describe('upgrade from a real PR-12 database', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let reviewer: StaffActor;
  let bookingReference: string;
  let passengerReference: string;
  let url: string;
  let workDir: string;
  let storageRoot: string;
  let before: Record<string, string | null>;
  let afterBaggage: {
    applied: string[];
    snapshot: Record<string, string | null>;
    counts: number[];
  };
  const name = `et_pr12_${randomBytes(6).toString('hex')}`;

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

  /** Every column of every PR-09..PR-12 row relevant to the populated journey. */
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        HISTORICAL_TABLES.map(async (table) => {
          const historicalJson =
            table === 'trip'
              ? "to_jsonb(x) - ARRAY['actual_departure_at', 'actual_arrival_at', 'departure_authorization_id']"
              : 'to_jsonb(x)';
          const [row] = await raw.$queryRawUnsafe<Array<{ value: string | null }>>(
            `SELECT jsonb_agg(${historicalJson} ORDER BY ${historicalJson})::text AS value FROM (SELECT * FROM "${table}") x`,
          );
          return [table, row!.value] as const;
        }),
      ),
    );

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-pr12-upgrade-'));
    storageRoot = mkdtempSync(join(tmpdir(), 'et-pr12-documents-'));
    const pr12 = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= COMPLIANCE_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(pr12, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: pr12 },
        datasource: { url },
      })};\n`,
    );
    deploy(config, url);
    raw = createDatabaseClient({ databaseUrl: url });
    expect(await applied()).toHaveLength(12);

    env = integrationEnv({ DATABASE_URL: url, OBJECT_STORAGE_LOCAL_ROOT: storageRoot });
    t = await startTestApp(env);
    [customer, reviewer] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['COMPLIANCE_AGENT']),
    ]);
    const subject = await confirmedPassenger(t.app, env, customer);
    bookingReference = subject.bookingReference;
    passengerReference = subject.passengerReference;
    const document = await uploadDocument(t.app, customer, passengerReference, {
      expiresAt: '2040-01-01',
    });
    if (document.status !== 201) throw new Error(`document fixture failed: ${document.text}`);

    const evaluated = await complianceApi(customer).evaluate(bookingReference, passengerReference);
    if (evaluated.status !== 200) throw new Error(`evaluation fixture failed: ${evaluated.text}`);
    const evaluationReference = evaluated.body.evaluation.reference as string;
    const reviewed = await adminApi(reviewer).post(
      `/compliance/evaluations/${evaluationReference}/reviews`,
      {
        decision: 'NEEDS_INFORMATION',
        reason: 'Revue synthétique pré-PR-13 conservée pendant la migration.',
        customerMessage: 'Information complémentaire synthétique.',
        previousReviewId: null,
      },
    );
    if (reviewed.status !== 201) throw new Error(`review fixture failed: ${reviewed.text}`);

    // Other PR-10 states: a FAILED attempt with its event, a PENDING retry and
    // a customer-cancelled hold.
    const fixture = await bookableFixture(t.app, { amount: () => 1_250 });
    const retried = await bookingApi(customer).post('/bookings', holdBody(fixture, 1, 3, ['2A']));
    const failed = await paymentApi(customer).create(retried.body.reference as string);
    await settle(t.app, env, failed.body.payment, 'payment.failed');
    await paymentApi(customer).create(retried.body.reference as string);
    const cancelled = await bookingApi(customer).post('/bookings', holdBody(fixture, 2, 4, ['2B']));
    await bookingApi(customer).post(`/bookings/${cancelled.body.reference}/cancel`);

    expect(await applied()).toHaveLength(12);
    expect((await applied()).at(-1)).toBe(COMPLIANCE_MIGRATION);
    expect(
      (
        await raw.$queryRawUnsafe<Array<{ status: string }>>(
          'SELECT status::text AS status FROM payment ORDER BY status',
        )
      ).map((row) => row.status),
    ).toEqual(['FAILED', 'PENDING', 'SUCCEEDED']);
    expect(await count('payment_event')).toBeGreaterThanOrEqual(2);
    expect(await count('passenger_document')).toBe(1);
    expect(await count('compliance_evaluation')).toBe(1);
    expect(await count('compliance_review')).toBe(1);
    before = await snapshot();

    // PR-13 alone first, measured on its own; then the real directory (PR-14
    // and any later additive migration).
    const pr13 = join(workDir, 'migrations-pr13');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= BAGGAGE_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(pr13, entry), { recursive: true });
      }
    }
    const pr13Config = join(workDir, 'prisma.pr13.config.mjs');
    writeFileSync(
      pr13Config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: pr13 },
        datasource: { url },
      })};\n`,
    );
    deploy(pr13Config, url);
    afterBaggage = {
      applied: await applied(),
      snapshot: await snapshot(),
      counts: [await count('baggage'), await count('baggage_event')],
    };
    deploy(null, url);
    // Three `prisma migrate deploy` processes now, as in the PR-11 upgrade test.
  }, 60_000);

  afterAll(async () => {
    await t?.app.close();
    await raw?.$disconnect();
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('applies only PR-13, preserves every populated historical row and backfills nothing', async () => {
    expect(afterBaggage.applied).toHaveLength(13);
    expect(afterBaggage.applied.at(-1)).toBe(BAGGAGE_MIGRATION);
    expect(afterBaggage.snapshot).toEqual(before);
    expect(afterBaggage.counts).toEqual([0, 0]);
    // Still true once the later migrations are applied.
    const migrations = await applied();
    expect(migrations).toHaveLength(18);
    expect(migrations.at(-1)).toBe(CREW_MIGRATION);
    expect(await snapshot()).toEqual(before);
    expect(await count('baggage')).toBe(0);
    expect(await count('baggage_event')).toBe(0);
    expect(
      Number(
        (
          await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
            "SELECT count(*) AS count FROM authorization_permission WHERE key LIKE 'baggage.%'",
          )
        )[0]!.count,
      ),
    ).toBe(2);
  });

  it('lets the historical BookingPassenger register its first atomic baggage after upgrade', async () => {
    const created = await customerBaggageApi(customer).register(
      bookingReference,
      passengerReference,
      { type: 'SUITCASE' },
    );
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({
      booking: { reference: bookingReference },
      passenger: { reference: passengerReference },
      lifecycleStatus: 'REGISTERED',
      events: [{ sequence: 1, type: 'REGISTERED' }],
    });
    expect(await count('baggage')).toBe(1);
    expect(await count('baggage_event')).toBe(1);
  });

  it('is idempotent under a second deploy and reports an up-to-date schema', async () => {
    deploy(null, url);
    const status = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(status).toContain('Database schema is up to date');
    expect(await applied()).toHaveLength(18);
  });
});
