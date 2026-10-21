import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiEnv } from '@euroteranga/config';
import { createDatabaseClient } from '@euroteranga/database';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../../src/auth/crypto/password-hasher.js';
import { client, cookiesOf, TEST_PASSWORD } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  type BookableFixture,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { CURRENT_MIGRATIONS } from '../../support/migrations.js';
import { paymentApi, settle, shortHold } from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const PAY_HUB_MIGRATION = '20261020090000_pay_hub_core';
const CUSTOMER = '01900000-0000-7000-8000-000000000c01';
const EMAIL = 'upgrade.payhub@example.test';
const HOLD_MS = 2 * 3_600_000;

const SNAPSHOTS = {
  payments: `SELECT json_agg(p ORDER BY p.id)::text AS value FROM (SELECT id, reference, booking_id, customer_identity_id, provider, provider_payment_id, status, amount_minor, currency_code, currency_minor_unit, idempotency_key, failure_code, created_at, updated_at, succeeded_at, failed_at, cancelled_at FROM payment) p`,
  events: `SELECT json_agg(e ORDER BY e.id)::text AS value FROM payment_event e`,
  bookings: `SELECT json_agg(b ORDER BY b.id)::text AS value FROM (SELECT id, reference, unit_amount_minor, currency_code, currency_minor_unit, hold_expires_at, confirmed_at, cancelled_at, updated_at FROM booking) b`,
};

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

const paymentReference = () =>
  `ETP-${Array.from(randomBytes(12), (byte) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[byte % 32]).join('')}`;

/**
 * Upgrade of a database holding PR-10 SANDBOX attempts (PENDING, SUCCEEDED
 * with its confirmed booking, FAILED) through PAY-HUB-1 and the current
 * schema: no payment, event or booking changes, no quote is invented, the
 * legacy attempts keep working, and every new attempt needs a quote.
 */
describe('upgrade to PAY-HUB-1 with PR-10 payments (isolated database)', () => {
  let t: TestApp;
  let env: ApiEnv;
  let url: string;
  let workDir: string;
  let customer: CustomerActor;
  let fixture: BookableFixture;
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  const name = `et_upg_${randomBytes(6).toString('hex')}`;
  const bookings: Record<'pending' | 'succeeded' | 'failed' | 'fresh' | 'other', string> = {
    pending: '',
    succeeded: '',
    failed: '',
    fresh: '',
    other: '',
  };
  const legacyPayments: Record<'pending' | 'succeeded' | 'failed', string> = {
    pending: '',
    succeeded: '',
    failed: '',
  };
  let before: Record<string, string> = {};
  let after: Record<string, string> = {};
  let appliedBefore: string[] = [];

  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(SNAPSHOTS).map(async ([key, sql]) => {
          const [row] = await raw.$queryRawUnsafe<Array<{ value: string }>>(sql);
          return [key, row!.value] as const;
        }),
      ),
    );
  const appliedMigrations = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);
  const count = async (sql: string) =>
    Number((await raw.$queryRawUnsafe<Array<{ count: bigint }>>(sql))[0]!.count);

  /** A PR-10 attempt, written under the PR-10 guards (and its result, if any). */
  const legacyPayment = async (
    bookingId: string,
    outcome: 'PENDING' | 'SUCCEEDED' | 'FAILED',
  ): Promise<string> => {
    const reference = paymentReference();
    await raw.$transaction(async (tx) => {
      const [payment] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO payment (id, reference, booking_id, customer_identity_id, provider, provider_payment_id,
           amount_minor, currency_code, currency_minor_unit, updated_at)
         SELECT gen_random_uuid(), '${reference}', b.id, b.customer_identity_id, 'SANDBOX',
           'sbx_legacy_${randomBytes(8).toString('hex')}', b.unit_amount_minor, b.currency_code, b.currency_minor_unit, now()
         FROM booking b WHERE b.id = '${bookingId}'
         RETURNING id`,
      );
      if (outcome === 'PENDING') return;
      await tx.$executeRawUnsafe(
        `INSERT INTO payment_event (id, payment_id, provider, provider_event_id, type, payload_hash, received_at, processed_at)
         VALUES (gen_random_uuid(), '${payment!.id}', 'SANDBOX', 'evt_legacy_${randomBytes(8).toString('hex')}',
           '${outcome === 'SUCCEEDED' ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_FAILED'}', '${randomBytes(32).toString('hex')}', now(), now())`,
      );
      if (outcome === 'SUCCEEDED') {
        await tx.$executeRawUnsafe(
          `UPDATE payment SET status = 'SUCCEEDED', succeeded_at = now(), updated_at = now() WHERE id = '${payment!.id}'`,
        );
        await tx.$executeRawUnsafe(
          `UPDATE booking SET confirmed_at = now(), updated_at = now() WHERE id = '${bookingId}'`,
        );
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE payment SET status = 'FAILED', failed_at = now(), failure_code = 'DECLINED', updated_at = now() WHERE id = '${payment!.id}'`,
        );
      }
    });
    return reference;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    // Every migration before PAY-HUB-1: the schema PR-10 payments live in today.
    workDir = mkdtempSync(join(tmpdir(), 'et-upgrade-payhub-'));
    const previous = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry < PAY_HUB_MIGRATION) {
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
    appliedBefore = await appliedMigrations();

    // Reference data through the test fixtures (tables PAY-HUB-1 does not change).
    const legacyApp = { get: () => ({ client: raw }) } as unknown as NestExpressApplication;
    await raw.$executeRawUnsafe(
      `INSERT INTO auth_identity (id, realm, email, normalized_email, status, email_verified_at, updated_at)
       VALUES ('${CUSTOMER}', 'CUSTOMER', '${EMAIL}', '${EMAIL}', 'ACTIVE', now(), now())`,
    );
    await raw.$executeRawUnsafe(
      `INSERT INTO password_credential (identity_id, password_hash, updated_at)
       VALUES ('${CUSTOMER}', '${await hashPassword(TEST_PASSWORD)}', now())`,
    );
    fixture = await bookableFixture(legacyApp, { amount: () => 12_450 });
    for (const [key, seat, origin, destination] of [
      ['pending', '1A', 1, 2],
      ['succeeded', '1B', 1, 2],
      ['failed', '2A', 1, 2],
      ['fresh', '2B', 1, 2],
      ['other', '1A', 2, 3],
    ] as const) {
      bookings[key] = (
        await shortHold(legacyApp, fixture, CUSTOMER, origin, destination, [seat], HOLD_MS)
      ).id;
    }
    legacyPayments.pending = await legacyPayment(bookings.pending, 'PENDING');
    legacyPayments.succeeded = await legacyPayment(bookings.succeeded, 'SUCCEEDED');
    legacyPayments.failed = await legacyPayment(bookings.failed, 'FAILED');
    before = await snapshot();

    // Upgrade through PAY-HUB-1 and every later migration currently
    // present in the repository. Later unrelated migrations must not mutate
    // historical payment, event or booking data.
    deploy(null, url);
    after = await snapshot();

    env = integrationEnv({ DATABASE_URL: url });
    t = await startTestApp(env);
    const http = client(t.app, 'customer');
    const login = await http.post('/v1/auth/customer/login', {
      email: EMAIL,
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(200);
    const cookie = `et_customer_session=${cookiesOf(login).et_customer_session}`;
    customer = {
      id: CUSTOMER,
      email: EMAIL,
      cookie,
      http,
      csrf: async () =>
        ((await http.get('/v1/auth/customer/csrf', cookie)).body as { csrfToken: string })
          .csrfToken,
    };
  }, 120_000);

  afterAll(async () => {
    await t?.app.close();
    await raw?.$disconnect();
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
  });

  const reference = async (bookingId: string) =>
    (
      await raw.$queryRawUnsafe<Array<{ reference: string }>>(
        `SELECT reference FROM booking WHERE id = '${bookingId}'`,
      )
    )[0]!.reference;

  it('applies PAY-HUB-1 and later migrations without changing payment, event or booking', async () => {
    expect(appliedBefore).toEqual(CURRENT_MIGRATIONS.filter((entry) => entry < PAY_HUB_MIGRATION));
    expect(await appliedMigrations()).toEqual(CURRENT_MIGRATIONS);
    expect(CURRENT_MIGRATIONS).toContain(PAY_HUB_MIGRATION);
    expect(after).toEqual(before);
    expect(JSON.parse(before.payments!)).toHaveLength(3);
    // No quote invented for the PR-10 attempts, no settlement either.
    expect(await count('SELECT count(*) AS count FROM payment WHERE quote_id IS NOT NULL')).toBe(0);
    expect(await count('SELECT count(*) AS count FROM payment_quote')).toBe(0);
    expect(await count('SELECT count(*) AS count FROM payment_settlement')).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS count FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'payment_provider'`,
      ),
    ).toBe(12);
  });

  it('keeps the PR-10 attempts readable and settles a legacy PENDING one on its own amount', async () => {
    const list = await paymentApi(customer).list(await reference(bookings.succeeded));
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        reference: legacyPayments.succeeded,
        status: 'SUCCEEDED',
        amountMinor: 12_450,
        currencyCode: 'EUR',
        paymentMethod: null,
        payerCountry: null,
        presentment: null,
      }),
    ]);
    // A legacy attempt has no quote: its event is checked against the payment amount.
    const result = await settle(t.app, env, {
      reference: legacyPayments.pending,
      amountMinor: 12_450,
      currencyCode: 'EUR',
    });
    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe('PAYMENT_SUCCEEDED');
    expect(
      await count(
        `SELECT count(*) AS count FROM booking WHERE id = '${bookings.pending}' AND confirmed_at IS NOT NULL`,
      ),
    ).toBe(1);
  });

  it('requires a quote for every new attempt after the upgrade', async () => {
    const fresh = await reference(bookings.fresh);
    const bare = await paymentApi(customer).create(fresh, { body: {} });
    expect(bare.status).toBe(400);
    const created = await paymentApi(customer).create(fresh);
    expect(created.status).toBe(201);
    expect(
      await count(
        `SELECT count(*) AS count FROM payment p JOIN payment_quote q ON q.id = p.quote_id WHERE p.booking_id = '${bookings.fresh}'`,
      ),
    ).toBe(1);
    await expect(
      raw.$executeRawUnsafe(
        `INSERT INTO payment (id, reference, booking_id, customer_identity_id, provider, amount_minor, currency_code, currency_minor_unit, updated_at)
         SELECT gen_random_uuid(), '${paymentReference()}', b.id, b.customer_identity_id, 'SANDBOX', b.unit_amount_minor, b.currency_code, b.currency_minor_unit, now()
         FROM booking b WHERE b.id = '${bookings.other}'`,
      ),
    ).rejects.toThrow(/needs a payment quote/);
  });
});
