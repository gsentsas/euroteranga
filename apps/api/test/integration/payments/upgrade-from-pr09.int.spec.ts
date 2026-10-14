import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiEnv } from '@euroteranga/config';
import { createDatabaseClient } from '@euroteranga/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../../src/auth/crypto/password-hasher.js';
import { client, cookiesOf, TEST_PASSWORD } from '../../support/auth-helpers.js';
import { bookingApi, type CustomerActor } from '../../support/booking-helpers.js';
import { paymentApi, settle } from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const BOOKING_MIGRATION = '20261013210000_booking';
const PAYMENT_MIGRATION = '20261013230000_payments';
const CHECK_IN_MIGRATION = '20261014190000_check_in_boarding';

const CUSTOMER = '01900000-0000-7000-8000-000000000a01';
const TRIP = '01900000-0000-7000-8000-000000000a81';
const ROUTE_VERSION = '01900000-0000-7000-8000-000000000ab2';
const ORIGIN = '01900000-0000-7000-8000-000000000ad1';
const DESTINATION = '01900000-0000-7000-8000-000000000ad2';
const SEAT_MAP_VERSION = '01900000-0000-7000-8000-000000000ae2';
const FARE_VERSION = '01900000-0000-7000-8000-000000000af8';
const FARE = '01900000-0000-7000-8000-000000000af9';
const CELL_A = '01900000-0000-7000-8000-000000000ac1';
const CELL_B = '01900000-0000-7000-8000-000000000ac2';
const TO_CANCEL = 'ETB-PR09CANCE000';
const TO_PAY = 'ETB-PR09PAYMENT0';

/**
 * A PR-09 database: published route, seat map and XOF fare table, a SCHEDULED
 * trip and an ACTIVE customer holding two seats in two HELD bookings (with
 * their seats and segment locks), written under every PR-09 guard.
 */
const pr09Data = (passwordHash: string) => [
  `INSERT INTO auth_identity (id, realm, email, normalized_email, status, email_verified_at, updated_at) VALUES
    ('${CUSTOMER}', 'CUSTOMER', 'upgrade.pr09@example.test', 'upgrade.pr09@example.test', 'ACTIVE', now(), now())`,
  `INSERT INTO password_credential (identity_id, password_hash, updated_at) VALUES ('${CUSTOMER}', '${passwordHash}', now())`,
  `INSERT INTO country (id, iso2, iso3, name, updated_at) VALUES ('01900000-0000-7000-8000-000000000ac0', 'QV', 'QVV', 'Pays montée PR-10', now())`,
  `INSERT INTO stop (id, code, name, country_id, locality, latitude, longitude, timezone, updated_at) VALUES
    ('01900000-0000-7000-8000-000000000aa1', 'UPP_A', 'Arrêt A synthétique', '01900000-0000-7000-8000-000000000ac0', 'L', 1, 1, 'Etc/UTC', now()),
    ('01900000-0000-7000-8000-000000000aa2', 'UPP_B', 'Arrêt B synthétique', '01900000-0000-7000-8000-000000000ac0', 'L', 1, 1, 'Etc/UTC', now())`,
  `INSERT INTO route (id, code, name, updated_at) VALUES ('01900000-0000-7000-8000-000000000ab1', 'UPP_ROUTE', 'Route montée PR-10', now())`,
  `INSERT INTO route_version (id, route_id, version, updated_at) VALUES ('${ROUTE_VERSION}', '01900000-0000-7000-8000-000000000ab1', 1, now())`,
  `INSERT INTO route_waypoint (id, route_version_id, sequence, stop_id, boarding_allowed, alighting_allowed) VALUES
    ('${ORIGIN}', '${ROUTE_VERSION}', 1, '01900000-0000-7000-8000-000000000aa1', true, false),
    ('${DESTINATION}', '${ROUTE_VERSION}', 2, '01900000-0000-7000-8000-000000000aa2', false, true)`,
  `UPDATE route_version SET status = 'PUBLISHED', published_at = now() WHERE id = '${ROUTE_VERSION}'`,
  `INSERT INTO seat_map (id, code, name, updated_at) VALUES ('01900000-0000-7000-8000-000000000ae1', 'UPP_SM', 'Plan montée PR-10', now())`,
  `INSERT INTO seat_map_version (id, seat_map_id, version, updated_at) VALUES ('${SEAT_MAP_VERSION}', '01900000-0000-7000-8000-000000000ae1', 1, now())`,
  `INSERT INTO seat_map_cell (id, seat_map_version_id, deck, row_number, column_number, kind, seat_label) VALUES
    ('${CELL_A}', '${SEAT_MAP_VERSION}', 1, 1, 1, 'SEAT', '1A'),
    ('${CELL_B}', '${SEAT_MAP_VERSION}', 1, 1, 2, 'SEAT', '1B')`,
  `UPDATE seat_map_version SET status = 'PUBLISHED', published_at = now() WHERE id = '${SEAT_MAP_VERSION}'`,
  `INSERT INTO fare_table (id, code, name, route_id, currency_code, currency_minor_unit, updated_at) VALUES
    ('01900000-0000-7000-8000-000000000af7', 'UPP_FT', 'Grille montée PR-10', '01900000-0000-7000-8000-000000000ab1', 'XOF', 0, now())`,
  `INSERT INTO fare_table_version (id, fare_table_id, route_version_id, version, updated_at) VALUES
    ('${FARE_VERSION}', '01900000-0000-7000-8000-000000000af7', '${ROUTE_VERSION}', 1, now())`,
  `INSERT INTO fare_entry (id, fare_table_version_id, origin_route_waypoint_id, destination_route_waypoint_id, amount_minor) VALUES
    ('${FARE}', '${FARE_VERSION}', '${ORIGIN}', '${DESTINATION}', 25000)`,
  `UPDATE fare_table_version SET status = 'PUBLISHED', published_at = now() WHERE id = '${FARE_VERSION}'`,
  `INSERT INTO trip (id, reference, route_version_id, seat_map_version_id, fare_table_version_id, updated_at) VALUES
    ('${TRIP}', 'ET-TEST-UPGRADE-09', '${ROUTE_VERSION}', '${SEAT_MAP_VERSION}', '${FARE_VERSION}', now())`,
  `INSERT INTO trip_waypoint_timing (id, trip_id, route_waypoint_id, sequence, planned_departure_at, planned_arrival_at) VALUES
    (gen_random_uuid(), '${TRIP}', '${ORIGIN}', 1, '2031-03-01T08:00:00Z', NULL),
    (gen_random_uuid(), '${TRIP}', '${DESTINATION}', 2, NULL, '2031-03-01T12:00:00Z')`,
  `UPDATE trip SET planned_departure_at = '2031-03-01T08:00:00Z', planned_arrival_at = '2031-03-01T12:00:00Z' WHERE id = '${TRIP}'`,
  `UPDATE trip SET status = 'SCHEDULED', scheduled_at = now() WHERE id = '${TRIP}'`,
  ...[
    [
      TO_CANCEL,
      CELL_A,
      '01900000-0000-7000-8000-000000000b01',
      '01900000-0000-7000-8000-000000000b11',
    ],
    [
      TO_PAY,
      CELL_B,
      '01900000-0000-7000-8000-000000000b02',
      '01900000-0000-7000-8000-000000000b12',
    ],
  ].flatMap(([reference, cell, booking, seat]) => [
    `INSERT INTO booking (id, reference, customer_identity_id, trip_id, origin_route_waypoint_id, destination_route_waypoint_id,
       origin_sequence, destination_sequence, fare_entry_id, unit_amount_minor, currency_code, currency_minor_unit,
       hold_expires_at, created_at, updated_at) VALUES
      ('${booking}', '${reference}', '${CUSTOMER}', '${TRIP}', '${ORIGIN}', '${DESTINATION}', 1, 2, '${FARE}', 25000, 'XOF', 0,
       now() + interval '2 hours', now(), now())`,
    `INSERT INTO booking_seat (id, booking_id, seat_map_cell_id) VALUES ('${seat}', '${booking}', '${cell}')`,
    `INSERT INTO seat_inventory_lock (id, booking_seat_id, trip_id, seat_map_cell_id, segment_sequence) VALUES
      (gen_random_uuid(), '${seat}', '${TRIP}', '${cell}', 1)`,
  ]),
];

const SNAPSHOTS = {
  bookings: `SELECT json_agg(b ORDER BY b.id)::text AS value FROM (SELECT id, reference, customer_identity_id, trip_id, origin_sequence, destination_sequence, fare_entry_id, unit_amount_minor, currency_code, currency_minor_unit, hold_expires_at, cancelled_at, cancellation_reason, created_at, updated_at FROM booking) b`,
  seats: `SELECT json_agg(s ORDER BY s.id)::text AS value FROM booking_seat s`,
  locks: `SELECT json_agg(l ORDER BY l.booking_seat_id, l.segment_sequence)::text AS value FROM (SELECT booking_seat_id, trip_id, seat_map_cell_id, segment_sequence, created_at FROM seat_inventory_lock) l`,
  trip: `SELECT row_to_json(t)::text AS value FROM (SELECT id, status, seat_map_version_id, fare_table_version_id, planned_departure_at, updated_at FROM trip) t`,
  grants: `SELECT json_agg(g ORDER BY g.role_key, g.permission_key)::text AS value FROM authorization_role_permission g WHERE g.permission_key NOT LIKE 'payment.%' AND g.permission_key <> 'passenger.document.read' AND g.permission_key NOT LIKE 'compliance.%' AND g.permission_key NOT LIKE 'baggage.%' AND g.permission_key NOT LIKE 'checkin.%' AND g.permission_key NOT LIKE 'boarding.%'`,
};

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    { cwd: DATABASE_PACKAGE, env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' },
  );
}

/**
 * Upgrade of an existing PR-09 database: the payment migration is measured in
 * isolation on HELD bookings with their inventory. Later migrations are then
 * applied, as a current deployment would, before the API starts.
 */
describe('upgrade from a PR-09 database (isolated database)', () => {
  let t: TestApp;
  let env: ApiEnv;
  let customer: CustomerActor;
  let url: string;
  let workDir: string;
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  const name = `et_upg_${randomBytes(6).toString('hex')}`;
  const before: Record<string, string> = {};
  let afterPaymentApplied: string[] = [];
  let afterPaymentSnapshot: Record<string, string> = {};

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

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    // The PR-09 migration set: every migration up to and including booking.
    workDir = mkdtempSync(join(tmpdir(), 'et-upgrade-'));
    const pr09 = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= BOOKING_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(pr09, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: pr09 },
        datasource: { url },
      })};\n`,
    );
    deploy(config, url);

    raw = createDatabaseClient({ databaseUrl: url });
    expect(await appliedMigrations()).toHaveLength(9);
    expect(
      await count(
        `SELECT count(*) AS count FROM information_schema.tables WHERE table_name = 'payment'`,
      ),
    ).toBe(0);
    for (const statement of pr09Data(await hashPassword(TEST_PASSWORD))) {
      await raw.$executeRawUnsafe(statement);
    }
    Object.assign(before, await snapshot());

    // Apply and measure exactly the PR-10 migration set first.
    const pr10 = join(workDir, 'pr10', 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= PAYMENT_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(pr10, entry), { recursive: true });
      }
    }
    const pr10Config = join(workDir, 'pr10', 'prisma.config.mjs');
    writeFileSync(
      pr10Config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: pr10 },
        datasource: { url },
      })};\n`,
    );
    deploy(pr10Config, url);
    afterPaymentApplied = await appliedMigrations();
    afterPaymentSnapshot = await snapshot();

    // The current directory: PR-11 and any later additive migrations.
    deploy(null, url);
    env = integrationEnv({ DATABASE_URL: url });
    t = await startTestApp(env);
    const http = client(t.app, 'customer');
    const login = await http.post('/v1/auth/customer/login', {
      email: 'upgrade.pr09@example.test',
      password: TEST_PASSWORD,
    });
    expect(login.status).toBe(200);
    const cookie = `et_customer_session=${cookiesOf(login).et_customer_session}`;
    customer = {
      id: CUSTOMER,
      email: 'upgrade.pr09@example.test',
      cookie,
      http,
      csrf: async () =>
        ((await http.get('/v1/auth/customer/csrf', cookie)).body as { csrfToken: string })
          .csrfToken,
    };
  }, 60_000);

  afterAll(async () => {
    await t?.app.close();
    await raw?.$disconnect();
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('applies only the payment migration and leaves PR-09 bookings untouched', async () => {
    expect(afterPaymentApplied).toHaveLength(10);
    expect(afterPaymentApplied.at(-1)).toBe(PAYMENT_MIGRATION);
    expect(afterPaymentSnapshot).toEqual(before);

    const applied = await appliedMigrations();
    expect(applied).toHaveLength(14);
    expect(applied.at(-1)).toBe(CHECK_IN_MIGRATION);
    expect(await snapshot()).toEqual(before);
    expect(
      await count(`SELECT count(*) AS count FROM booking WHERE confirmed_at IS NOT NULL`),
    ).toBe(0);
    expect(
      await count(`SELECT count(*) AS count FROM booking_seat WHERE released_at IS NOT NULL`),
    ).toBe(0);
    expect(await count(`SELECT count(*) AS count FROM seat_inventory_lock`)).toBe(2);
    for (const table of ['payment', 'payment_event']) {
      expect(await count(`SELECT count(*) AS count FROM "${table}"`), table).toBe(0);
    }
    expect(
      await count(
        `SELECT count(*) AS count FROM authorization_permission WHERE key LIKE 'payment.%'`,
      ),
    ).toBe(2);
    expect(
      await count(
        `SELECT count(*) AS count FROM authorization_role_permission WHERE permission_key LIKE 'payment.%'`,
      ),
    ).toBe(10);
  });

  it('keeps historical holds HELD, occupying their seats, and cancellable', async () => {
    const held = await bookingApi(customer).get(`/bookings/${TO_CANCEL}`);
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({
      status: 'HELD',
      confirmedAt: null,
      payment: null,
      totalAmountMinor: 25_000,
    });
    const availability = () =>
      request(t.app.getHttpServer()).get(
        `/v1/booking/trips/${TRIP}/availability?originRouteWaypointId=${ORIGIN}&destinationRouteWaypointId=${DESTINATION}`,
      );
    expect((await availability()).body.availableSeatCount).toBe(0);
    const cancelled = await bookingApi(customer).post(`/bookings/${TO_CANCEL}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', payment: null });
    expect((await availability()).body.availableSeatCount).toBe(1);
    expect(await count(`SELECT count(*) AS count FROM payment`)).toBe(0);
  });

  it('lets a historical hold be paid and confirmed with its exact snapshot', async () => {
    const attempt = await paymentApi(customer).create(TO_PAY);
    expect(attempt.status).toBe(201);
    expect(attempt.body.payment).toMatchObject({
      amountMinor: 25_000,
      currencyCode: 'XOF',
      currencyMinorUnit: 0,
    });
    expect((await settle(t.app, env, attempt.body.payment)).status).toBe(200);
    const confirmed = await bookingApi(customer).get(`/bookings/${TO_PAY}`);
    expect(confirmed.body).toMatchObject({ status: 'CONFIRMED', payment: { status: 'SUCCEEDED' } });
  });
});
