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
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import {
  boardingApi,
  customerCheckInApi,
  staffCheckInApi,
} from '../../support/check-in-helpers.js';
import {
  complianceApi,
  confirmedJourney,
  coverage,
  journeyPassenger,
  publishRule,
} from '../../support/compliance-helpers.js';
import { uploadDocument } from '../../support/passenger-document-helpers.js';
import { paymentApi, settle } from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';
import { CURRENT_MIGRATIONS, historical, withoutPaymentHub } from '../../support/migrations.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const BAGGAGE_MIGRATION = '20261014150000_baggage';
const REPORTING_MIGRATION = '20261017160000_reporting';
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
  'baggage',
  'baggage_event',
  'audit_event',
] as const;
const PR14_TABLES = ['booking_passenger_seat', 'passenger_check_in', 'passenger_boarding'];

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

/** A real PR-13 database is populated before later migrations run.
 *
 * Most fixtures use today's APIs. Baggage is seeded through the historical
 * PR-13 tables themselves because the current Baggage API legitimately
 * expects the newer BAGGAGE-PLUS schema to exist.
 */
describe('upgrade from a real PR-13 database', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let director: StaffActor;
  let reviewer: StaffActor;
  let operator: StaffActor;
  let bookingReference: string;
  let passengerReference: string;
  let url: string;
  let workDir: string;
  let storageRoot: string;
  let before: Record<string, string | null>;
  const name = `et_pr13_${randomBytes(6).toString('hex')}`;

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

  /** Every column of every PR-09..PR-13 row of the populated journeys. */
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        HISTORICAL_TABLES.map(async (table) => {
          const historicalJson =
            table === 'trip'
              ? "to_jsonb(x) - ARRAY['actual_departure_at', 'actual_arrival_at', 'departure_authorization_id', 'support_vehicle_id']"
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

    workDir = mkdtempSync(join(tmpdir(), 'et-pr13-upgrade-'));
    storageRoot = mkdtempSync(join(tmpdir(), 'et-pr13-documents-'));
    const pr13 = join(workDir, 'migrations');
    // PAY-HUB-1 belongs to this history only because it is built through
    // today's API (which starts no payment without a quote): here it runs
    // before the later migrations, an order production never sees. The real
    // order, every migration then PAY-HUB-1 on PR-10 payments, is measured
    // by payments/upgrade-from-pr10-payments.int.spec.ts.
    for (const entry of readdirSync(MIGRATIONS)) {
      if (historical(entry, BAGGAGE_MIGRATION)) {
        cpSync(join(MIGRATIONS, entry), join(pr13, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: pr13 },
        datasource: { url },
      })};\n`,
    );
    deploy(config, url);
    raw = createDatabaseClient({ databaseUrl: url });
    expect(withoutPaymentHub(await applied())).toHaveLength(13);

    env = integrationEnv({ DATABASE_URL: url, OBJECT_STORAGE_LOCAL_ROOT: storageRoot });
    t = await startTestApp(env);
    [customer, director, reviewer, operator] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['COMPLIANCE_AGENT']),
      staffActor(t.app, ['OPS_MANAGER']),
    ]);

    // A confirmed two-seat journey with a SUCCEEDED payment.
    const journey = await confirmedJourney(t.app, env, customer, { seats: ['1A', '1B'] });
    bookingReference = journey.bookingReference;
    passengerReference = await journeyPassenger(customer, journey, journey.origin.id);
    // An uploaded, technically ACCEPTED passport through the PR-11 pipeline.
    const document = await uploadDocument(t.app, customer, passengerReference, {
      expiresAt: '2040-01-01',
    });
    if (document.status !== 201) throw new Error(`document fixture failed: ${document.text}`);
    // A published synthetic rule requiring it, a PASS evaluation and a review.
    await publishRule(director, {
      definition: {
        ...coverage(journey),
        requirement: { kind: 'DOCUMENT', documentType: 'PASSPORT' },
      },
    });
    const evaluated = await complianceApi(customer).evaluate(bookingReference, passengerReference);
    if (evaluated.body.status !== 'COMPLIANT_BY_RULES') {
      throw new Error(`evaluation fixture failed: ${evaluated.text}`);
    }
    const reviewed = await adminApi(reviewer).post(
      `/compliance/evaluations/${evaluated.body.evaluation.reference}/reviews`,
      {
        decision: 'COMPLIANT',
        reason: 'Revue synthétique pré-PR-14 conservée pendant la migration.',
        previousReviewId: null,
      },
    );
    if (reviewed.status !== 201) throw new Error(`review fixture failed: ${reviewed.text}`);
    // Baggage with a real PR-13 event history, including a resolved exception.
    // Seed it against the historical schema so this migration test does not
    // require a newer application service to run on an older database.
    const baggageReference = 'ETG-0123456789AB';
    await raw.$transaction(async (tx) => {
      const [subject] = await tx.$queryRawUnsafe<
        Array<{ booking_id: string; passenger_id: string }>
      >(
        `SELECT b.id::text AS booking_id, p.id::text AS passenger_id
         FROM booking b
         JOIN booking_passenger bp ON bp.booking_id = b.id
         JOIN passenger p ON p.id = bp.passenger_id
         WHERE b.reference = $1 AND p.reference = $2`,
        bookingReference,
        passengerReference,
      );
      if (!subject) throw new Error('historical baggage subject fixture is missing');

      const [bag] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO baggage (
           id, reference, booking_id, passenger_id, type,
           lifecycle_status, created_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2::uuid, $3::uuid, 'SUITCASE',
           'REGISTERED', now(), now()
         )
         RETURNING id::text AS id`,
        baggageReference,
        subject.booking_id,
        subject.passenger_id,
      );
      if (!bag) throw new Error('historical baggage row fixture was not created');

      const record = async (
        sequence: number,
        type: string,
        lifecycleStatus: string,
        exceptionStatus: string | null,
        measuredWeightKg: string | null,
        actorIdentityId: string,
        fingerprintChar: string,
      ) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO baggage_event (
             id, baggage_id, sequence, type, lifecycle_status, exception_status,
             measured_weight_kg, occurred_at, actor_identity_id, payload_fingerprint
           ) VALUES (
             gen_random_uuid(), $1::uuid, $2, $3::baggage_event_type,
             $4::baggage_lifecycle_status, $5::baggage_exception_status,
             $6::numeric, now(), $7::uuid, $8
           )`,
          bag.id,
          sequence,
          type,
          lifecycleStatus,
          exceptionStatus,
          measuredWeightKg,
          actorIdentityId,
          fingerprintChar.repeat(64),
        );
        await tx.$executeRawUnsafe(
          `UPDATE baggage
           SET lifecycle_status = $2::baggage_lifecycle_status,
               exception_status = $3::baggage_exception_status,
               measured_weight_kg = $4::numeric,
               updated_at = now()
           WHERE id = $1::uuid`,
          bag.id,
          lifecycleStatus,
          exceptionStatus,
          measuredWeightKg,
        );
      };

      await record(1, 'REGISTERED', 'REGISTERED', null, null, customer.id, 'a');
      await record(2, 'CHECKED_IN', 'CHECKED_IN', null, null, operator.id, 'b');
      await record(3, 'DAMAGED', 'CHECKED_IN', 'DAMAGED', null, operator.id, 'c');
      await record(4, 'EXCEPTION_RESOLVED', 'CHECKED_IN', null, null, operator.id, 'd');
      await record(5, 'WEIGHT_UPDATED', 'CHECKED_IN', null, '18.250', operator.id, 'e');
    });
    // Other PR-10 states: a FAILED attempt, a PENDING retry, a cancelled hold.
    const fixture = await bookableFixture(t.app, { amount: () => 1_250 });
    const retried = await bookingApi(customer).post('/bookings', holdBody(fixture, 1, 3, ['2A']));
    const failed = await paymentApi(customer).create(retried.body.reference as string);
    await settle(t.app, env, failed.body.payment, 'payment.failed');
    await paymentApi(customer).create(retried.body.reference as string);
    const cancelled = await bookingApi(customer).post('/bookings', holdBody(fixture, 2, 4, ['2B']));
    await bookingApi(customer).post(`/bookings/${cancelled.body.reference}/cancel`);

    expect(withoutPaymentHub(await applied())).toHaveLength(13);
    expect(withoutPaymentHub(await applied()).at(-1)).toBe(BAGGAGE_MIGRATION);
    expect(
      (
        await raw.$queryRawUnsafe<Array<{ status: string }>>(
          'SELECT status::text AS status FROM payment ORDER BY status',
        )
      ).map((row) => row.status),
    ).toEqual(['FAILED', 'PENDING', 'SUCCEEDED']);
    expect(await count('baggage_event')).toBe(5);
    expect(await count('compliance_review')).toBe(1);
    before = await snapshot();

    // The real migration directory now contains PR-14 and PR-15 as pending.
    deploy(null, url);
  }, 60_000);

  afterAll(async () => {
    await t?.app.close();
    await raw?.$disconnect();
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('applies PR-14 and PR-15, keeps every PR-13 row identical and backfills nothing', async () => {
    const migrations = await applied();
    expect(migrations).toEqual(CURRENT_MIGRATIONS);
    expect(migrations).toContain(REPORTING_MIGRATION);
    expect(await snapshot()).toEqual(before);
    for (const table of PR14_TABLES) expect(await count(table), table).toBe(0);
    expect(
      Number(
        (
          await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
            "SELECT count(*) AS count FROM authorization_permission WHERE key LIKE 'checkin.%' OR key LIKE 'boarding.%'",
          )
        )[0]!.count,
      ),
    ).toBe(4);
  });

  it('lets the historical BookingPassenger take a seat, check in, get a QR and board', async () => {
    const api = customerCheckInApi(customer);
    const blocked = await api.readiness(bookingReference, passengerReference);
    expect(blocked.body.blockers).toEqual([{ check: 'SEAT', code: 'SEAT_NOT_ASSIGNED' }]);
    expect((await api.seat(bookingReference, passengerReference, { seatLabel: '1B' })).status).toBe(
      201,
    );
    const checkIn = await api.checkIn(bookingReference, passengerReference);
    expect(checkIn.status, checkIn.text).toBe(201);
    expect(checkIn.body.checkIn).toMatchObject({ seat: { label: '1B' }, boarding: null });
    const qr = await api.qr(checkIn.body.checkIn.reference);
    expect(qr.status).toBe(200);
    const boarded = await boardingApi(operator).scan({
      qrPayload: checkIn.body.checkIn.qrPayload,
      deviceId: 'upgrade-gate',
    });
    expect(boarded.status, boarded.text).toBe(201);
    const detail = await staffCheckInApi(operator).detail(bookingReference, passengerReference);
    expect(detail.body.checkIn.boarding).toMatchObject({ deviceId: 'upgrade-gate' });
    for (const table of PR14_TABLES) expect(await count(table), table).toBe(1);
  });

  it('is idempotent under a second deploy and reports an up-to-date schema', async () => {
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
