import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi,
  isolatedDatabase,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  type BookableFixture,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { paymentApi, settle } from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

describe('PR-23 operational reporting', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let t: TestApp;
  let reporter: StaffActor;
  let denied: StaffActor;
  let customer: CustomerActor;
  let env: ReturnType<typeof integrationEnv>;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url, BOOKING_HOLD_TTL_SECONDS: '900' });
    t = await startTestApp(env);
    [reporter, denied, customer] = await Promise.all([
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['FINANCE']),
      customerActor(t.app),
    ]);
  }, 120_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
  });

  async function confirm(fixture: BookableFixture, seat: string) {
    const held = await bookingApi(customer).post('/bookings', holdBody(fixture, 1, 2, [seat]));
    expect(held.status, held.text).toBe(201);
    const payment = await paymentApi(customer).create(held.body.reference as string);
    expect(payment.status, payment.text).toBe(201);
    const settled = await settle(t.app, env, payment.body.payment);
    expect(settled.status, settled.text).toBe(200);
  }

  it('aggregates authoritative facts, isolates currencies and exposes no passenger PII', async () => {
    const eur = await bookableFixture(t.app, { currencyCode: 'EUR', currencyMinorUnit: 2 });
    const xof = await bookableFixture(t.app, { currencyCode: 'XOF', currencyMinorUnit: 0 });
    await confirm(eur, '1A');
    await confirm(xof, '1B');

    const [eurTrip, xofTrip] = await Promise.all([
      db(t.app).trip.findUniqueOrThrow({
        where: { id: eur.tripId },
        select: { plannedDepartureAt: true },
      }),
      db(t.app).trip.findUniqueOrThrow({
        where: { id: xof.tripId },
        select: { plannedDepartureAt: true },
      }),
    ]);
    const departures = [eurTrip.plannedDepartureAt!, xofTrip.plannedDepartureAt!];
    const from = new Date(Math.min(...departures.map((value) => value.getTime())) - 60_000);
    const to = new Date(Math.max(...departures.map((value) => value.getTime())) + 60_000);
    const path = `/reporting/overview?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;

    expect((await adminApi(denied).get(path)).status).toBe(403);
    const response = await adminApi(reporter).get(path);
    expect(response.status, response.text).toBe(200);
    expect(response.body.period.semantics).toBe('[from,to) on trip.plannedDepartureAt');
    expect(response.body.commercial.confirmedBookingCount).toBe(2);
    expect(response.body.commercial.soldSeatCount).toBe(2);
    expect(response.body.privacy).toEqual({ containsPassengerPii: false });
    expect(response.body.finance.fxConversionApplied).toBe(false);
    expect(
      response.body.finance.currencies.map((item: { currencyCode: string }) => item.currencyCode),
    ).toEqual(['EUR', 'XOF']);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/@fixtures|givenName|familyName|dateOfBirth|documentNumber/i);
  });

  it('uses half-open planned-departure boundaries and returns explicit empty KPI', async () => {
    const fixture = await bookableFixture(t.app);
    const trip = await db(t.app).trip.findUniqueOrThrow({
      where: { id: fixture.tripId },
      select: { plannedDepartureAt: true },
    });
    const departure = trip.plannedDepartureAt!;
    const exactlyExcluded = await adminApi(reporter).get(
      `/reporting/overview?from=${encodeURIComponent(new Date(departure.getTime() - 60_000).toISOString())}&to=${encodeURIComponent(departure.toISOString())}`,
    );
    expect(exactlyExcluded.status, exactlyExcluded.text).toBe(200);
    expect(exactlyExcluded.body.activity.tripCount).toBe(0);
    expect(exactlyExcluded.body.commercial.loadFactor).toBeNull();
    expect(JSON.stringify(exactlyExcluded.body)).not.toMatch(/NaN|Infinity/);
  });

  it('exports the exact authorized aggregate as CSV and XLSX', async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const csv = await adminApi(reporter).get(
      `/reporting/export.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('section');

    const xlsx = await adminApi(reporter).get(
      `/reporting/export.xlsx?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});
