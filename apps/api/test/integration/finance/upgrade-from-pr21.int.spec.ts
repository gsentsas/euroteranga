import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
} from '../../support/booking-helpers.js';
import { paymentApi, settle } from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';
import { CURRENT_MIGRATIONS, historical, withoutPaymentHub } from '../../support/migrations.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const PR21_MIGRATION = '20261017083000_incidents';
const REPORTING_MIGRATION = '20261017160000_reporting';

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

describe('upgrade from a real PR-21 database', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let app: TestApp | undefined;
  let workDir: string;
  let url: string;
  let bookingReference: string;
  let paymentReference: string;
  let paymentAmountMinor: bigint;
  let seatLockCount: number;
  const name = 'et_pr21_' + randomBytes(6).toString('hex');

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');

    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe('CREATE DATABASE "' + name + '"');
    const target = new URL(base);
    target.pathname = '/' + name;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-pr21-upgrade-'));
    const historicalMigrations = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (historical(entry, PR21_MIGRATION)) {
        cpSync(join(MIGRATIONS, entry), join(historicalMigrations, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      'export default ' +
        JSON.stringify({
          schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
          migrations: { path: historicalMigrations },
          datasource: { url },
        }) +
        ';' +
        String.fromCharCode(10),
    );
    deploy(config, url);

    raw = createDatabaseClient({ databaseUrl: url });
    expect(withoutPaymentHub(await applied())).toHaveLength(21);
    expect(withoutPaymentHub(await applied()).at(-1)).toBe(PR21_MIGRATION);

    const before = await raw.$queryRawUnsafe<
      Array<{ revenue: string | null; refund: string | null }>
    >(
      "SELECT to_regclass('public.trip_revenue')::text AS revenue, to_regclass('public.refund')::text AS refund",
    );
    expect(before[0]).toEqual({ revenue: null, refund: null });

    const env = integrationEnv({ DATABASE_URL: url, BOOKING_HOLD_TTL_SECONDS: '900' });
    app = await startTestApp(env);
    const customer = await customerActor(app.app);
    const fixture = await bookableFixture(app.app, {
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
    });
    const held = await bookingApi(customer).post('/bookings', holdBody(fixture, 1, 3, ['1A']));
    if (held.status !== 201) throw new Error('historical booking failed: ' + held.text);
    bookingReference = held.body.reference as string;

    const createdPayment = await paymentApi(customer).create(bookingReference);
    if (createdPayment.status !== 201) {
      throw new Error('historical payment creation failed: ' + createdPayment.text);
    }
    const payment = createdPayment.body.payment as {
      reference: string;
      amountMinor: number;
      currencyCode: string;
    };
    paymentReference = payment.reference;
    const webhook = await settle(app.app, env, payment);
    if (webhook.status !== 200)
      throw new Error('historical payment settlement failed: ' + webhook.text);

    const storedPayment = await raw.payment.findUniqueOrThrow({
      where: { reference: paymentReference },
      select: { amountMinor: true, status: true },
    });
    expect(storedPayment.status).toBe('SUCCEEDED');
    paymentAmountMinor = storedPayment.amountMinor;

    const booking = await raw.booking.findUniqueOrThrow({
      where: { reference: bookingReference },
      select: { id: true, confirmedAt: true, cancelledAt: true },
    });
    expect(booking.confirmedAt).toBeTruthy();
    expect(booking.cancelledAt).toBeNull();
    seatLockCount = await raw.seatInventoryLock.count({
      where: { bookingSeat: { bookingId: booking.id } },
    });
    expect(seatLockCount).toBeGreaterThan(0);

    await app.app.close();
    app = undefined;
    deploy(null, url);
  }, 120_000);

  afterAll(async () => {
    await app?.app.close();
    await raw?.$disconnect();
    if (root) {
      await root.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      await root.$disconnect();
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('applies PR-22 and PR-23 on top of PR-21 and preserves the paid booking', async () => {
    expect(await applied()).toEqual(CURRENT_MIGRATIONS);
    expect(await applied()).toContain(REPORTING_MIGRATION);

    const payment = await raw.payment.findUniqueOrThrow({
      where: { reference: paymentReference },
      select: { amountMinor: true, status: true },
    });
    expect(payment).toEqual({ amountMinor: paymentAmountMinor, status: 'SUCCEEDED' });

    const booking = await raw.booking.findUniqueOrThrow({
      where: { reference: bookingReference },
      select: { id: true, confirmedAt: true, cancelledAt: true },
    });
    expect(booking.confirmedAt).toBeTruthy();
    expect(booking.cancelledAt).toBeNull();
    expect(
      await raw.seatInventoryLock.count({
        where: { bookingSeat: { bookingId: booking.id } },
      }),
    ).toBe(seatLockCount);

    expect(await raw.tripRevenue.count()).toBe(0);
    expect(await raw.tripExpense.count()).toBe(0);
    expect(await raw.refund.count()).toBe(0);
    expect(await raw.creditNote.count()).toBe(0);
    expect(await raw.payout.count()).toBe(0);
    expect(await raw.financeReceipt.count()).toBe(0);
  });

  it('seeds the exact finance permissions and grants', async () => {
    const permissions = await raw.authorizationPermission.findMany({
      where: { key: { in: ['finance.read', 'finance.manage', 'payment.refund'] } },
      orderBy: { key: 'asc' },
      select: { key: true },
    });
    expect(permissions.map((permission) => permission.key)).toEqual([
      'finance.manage',
      'finance.read',
      'payment.refund',
    ]);

    const grants = await raw.authorizationRolePermission.findMany({
      where: { permissionKey: { in: ['finance.read', 'finance.manage', 'payment.refund'] } },
      orderBy: [{ permissionKey: 'asc' }, { roleKey: 'asc' }],
      select: { permissionKey: true, roleKey: true },
    });
    expect(grants).toEqual([
      { permissionKey: 'finance.manage', roleKey: 'DIRECTOR' },
      { permissionKey: 'finance.manage', roleKey: 'FINANCE' },
      { permissionKey: 'finance.manage', roleKey: 'SUPER_ADMIN' },
      { permissionKey: 'finance.read', roleKey: 'AUDITOR' },
      { permissionKey: 'finance.read', roleKey: 'DIRECTOR' },
      { permissionKey: 'finance.read', roleKey: 'FINANCE' },
      { permissionKey: 'finance.read', roleKey: 'OPS_MANAGER' },
      { permissionKey: 'finance.read', roleKey: 'SUPER_ADMIN' },
      { permissionKey: 'payment.refund', roleKey: 'DIRECTOR' },
      { permissionKey: 'payment.refund', roleKey: 'FINANCE' },
      { permissionKey: 'payment.refund', roleKey: 'SUPER_ADMIN' },
    ]);
  });

  it('is idempotent and reports all 23 migrations applied', async () => {
    deploy(null, url);
    expect(await applied()).toEqual(CURRENT_MIGRATIONS);
    const status = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(status).toContain('Database schema is up to date');
  });
});
