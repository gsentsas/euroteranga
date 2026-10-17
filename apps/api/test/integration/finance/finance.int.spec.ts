import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiEnv } from '@euroteranga/config';
import request from 'supertest';
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

describe('PR-22 operational finance', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let storageRoot: string;
  let env: ApiEnv;
  let t: TestApp;
  let finance: StaffActor;
  let reader: StaffActor;
  let denied: StaffActor;
  let manager: StaffActor;
  let customer: CustomerActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    storageRoot = await mkdtemp(join(tmpdir(), 'et-finance-receipts-'));
    env = integrationEnv({
      DATABASE_URL: database.url,
      OBJECT_STORAGE_LOCAL_ROOT: storageRoot,
      BOOKING_HOLD_TTL_SECONDS: '900',
    });
    t = await startTestApp(env);
    [finance, reader, denied, manager, customer] = await Promise.all([
      staffActor(t.app, ['FINANCE']),
      staffActor(t.app, ['OPS_MANAGER']),
      staffActor(t.app, ['BOOKING_AGENT']),
      staffActor(t.app, ['SUPER_ADMIN']),
      customerActor(t.app),
    ]);
  }, 120_000);

  afterAll(async () => {
    await t?.app.close();
    await database?.drop();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  const financeGet = (actor: StaffActor, path: string) => adminApi(actor).get('/finance' + path);
  const financePost = (actor: StaffActor, path: string, body: unknown = {}) =>
    adminApi(actor).post('/finance' + path, body);

  async function createConfirmedBooking(
    fixture: BookableFixture,
    seats: string[] = ['1A'],
  ): Promise<{
    bookingReference: string;
    paymentReference: string;
    amountMinor: number;
  }> {
    const held = await bookingApi(customer).post('/bookings', holdBody(fixture, 1, 3, seats));
    expect(held.status, held.text).toBe(201);
    const bookingReference = held.body.reference as string;
    const payment = await paymentApi(customer).create(bookingReference);
    expect(payment.status, payment.text).toBe(201);
    const view = payment.body.payment as {
      reference: string;
      amountMinor: number;
      currencyCode: string;
    };
    const webhook = await settle(t.app, env, view);
    expect(webhook.status, webhook.text).toBe(200);
    const stored = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: bookingReference },
    });
    expect(stored.confirmedAt).toBeTruthy();
    return {
      bookingReference,
      paymentReference: view.reference,
      amountMinor: view.amountMinor,
    };
  }

  it('separates finance read/manage and keeps contribution isolated per currency', async () => {
    const fixture = await bookableFixture(t.app, { currencyCode: 'EUR', currencyMinorUnit: 2 });

    expect((await financeGet(denied, '/trips/' + fixture.tripReference)).status).toBe(403);
    expect((await financeGet(reader, '/trips/' + fixture.tripReference)).status).toBe(200);

    const readerWrite = await financePost(reader, '/trips/' + fixture.tripReference + '/revenues', {
      type: 'OPTION',
      amountMinor: '10000',
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      description: 'Option opérationnelle de test',
      occurredAt: new Date().toISOString(),
    });
    expect(readerWrite.status).toBe(403);

    const revenue = await financePost(finance, '/trips/' + fixture.tripReference + '/revenues', {
      type: 'OPTION',
      amountMinor: '10000',
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      description: 'Option opérationnelle de test',
      occurredAt: new Date().toISOString(),
    });
    expect(revenue.status, revenue.text).toBe(201);

    const expense = await financePost(finance, '/trips/' + fixture.tripReference + '/expenses', {
      type: 'FUEL',
      amountMinor: '50000',
      currencyCode: 'XOF',
      currencyMinorUnit: 0,
      description: 'Carburant opérationnel de test',
      vendorLabel: 'Fournisseur synthétique',
      occurredAt: new Date().toISOString(),
    });
    expect(expense.status, expense.text).toBe(201);

    const summary = await financeGet(finance, '/trips/' + fixture.tripReference);
    expect(summary.status, summary.text).toBe(200);
    expect(summary.body.fxConversionApplied).toBe(false);
    expect(summary.body.currencies).toEqual([
      expect.objectContaining({
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        additionalRevenueMinor: '10000',
        contributionMinor: '10000',
      }),
      expect.objectContaining({
        currencyCode: 'XOF',
        currencyMinorUnit: 0,
        expenseMinor: '50000',
        contributionMinor: '-50000',
      }),
    ]);

    const expenseReference = expense.body.reference as string;
    const payout = await financePost(finance, '/expenses/' + expenseReference + '/payouts', {
      clientPayoutId: 'payout-test-0001',
      amountMinor: '30000',
      paidAt: new Date().toISOString(),
      note: 'Règlement partiel de test',
    });
    expect(payout.status, payout.text).toBe(201);

    const over = await financePost(finance, '/expenses/' + expenseReference + '/payouts', {
      clientPayoutId: 'payout-test-0002',
      amountMinor: '30000',
      paidAt: new Date().toISOString(),
    });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('FINANCE_PAYOUT_EXCEEDS_EXPENSE');

    const voidPaid = await financePost(finance, '/expenses/' + expenseReference + '/void', {
      reason: 'Correction impossible après règlement',
    });
    expect(voidPaid.status).toBe(409);
    expect(voidPaid.body.code).toBe('FINANCE_EXPENSE_ALREADY_PAID');

    const csrf = await finance.csrf();
    const pdf = Buffer.from(
      ['%PDF-1.7', 'finance-receipt', '%%EOF', ''].join(String.fromCharCode(10)),
      'utf8',
    );
    const uploaded = await request(t.app.getHttpServer())
      .post('/v1/admin/finance/expenses/' + expenseReference + '/receipts')
      .set('Origin', finance.http.origin)
      .set('X-Forwarded-For', finance.ip)
      .set('Cookie', finance.cookie)
      .set('X-CSRF-Token', csrf)
      .attach('file', pdf, { filename: 'recu.pdf', contentType: 'application/pdf' });
    expect(uploaded.status, uploaded.text).toBe(201);
    expect(JSON.stringify(uploaded.body)).not.toMatch(/objectKey|bucket|scanner|path/i);

    const downloaded = await request(t.app.getHttpServer())
      .get(
        '/v1/admin/finance/expenses/' +
          expenseReference +
          '/receipts/' +
          String(uploaded.body.id) +
          '/download',
      )
      .set('Origin', finance.http.origin)
      .set('X-Forwarded-For', finance.ip)
      .set('Cookie', finance.cookie);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(downloaded.body as Buffer, pdf)).toBe(0);

    const csv = await financeGet(finance, '/trips/' + fixture.tripReference + '/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('CONTRIBUTION');
    expect(csv.text).toContain('XOF');

    const xlsx = await request(t.app.getHttpServer())
      .get('/v1/admin/finance/trips/' + fixture.tripReference + '/export.xlsx')
      .set('Origin', finance.http.origin)
      .set('X-Forwarded-For', finance.ip)
      .set('Cookie', finance.cookie)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect((xlsx.body as Buffer).subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('records refunds with credit notes and releases a booking only after full refund', async () => {
    const fixture = await bookableFixture(t.app, { currencyCode: 'EUR', currencyMinorUnit: 2 });
    const confirmed = await createConfirmedBooking(fixture, ['1A', '1B']);

    const beforeRefund = await bookingApi(customer).post(
      '/bookings/' + confirmed.bookingReference + '/cancel',
      {},
    );
    expect(beforeRefund.status).toBe(409);
    expect(beforeRefund.body.code).toBe('BOOKING_CONFIRMED');

    const firstAmount = Math.floor(confirmed.amountMinor / 2);
    const first = await financePost(
      finance,
      '/payments/' + confirmed.paymentReference + '/refunds',
      {
        clientRefundId: 'refund-test-0001',
        amountMinor: String(firstAmount),
        reason: 'Remboursement partiel de test',
      },
    );
    expect(first.status, first.text).toBe(201);
    expect(first.body.created).toBe(true);
    expect(first.body.refund.creditNote.reference).toMatch(/^ETCN-/);

    const replay = await financePost(
      finance,
      '/payments/' + confirmed.paymentReference + '/refunds',
      {
        clientRefundId: 'refund-test-0001',
        amountMinor: String(firstAmount),
        reason: 'Remboursement partiel de test',
      },
    );
    expect(replay.status, replay.text).toBe(201);
    expect(replay.body.created).toBe(false);

    const changedReplay = await financePost(
      finance,
      '/payments/' + confirmed.paymentReference + '/refunds',
      {
        clientRefundId: 'refund-test-0001',
        amountMinor: String(firstAmount + 1),
        reason: 'Remboursement partiel de test',
      },
    );
    expect(changedReplay.status).toBe(409);
    expect(changedReplay.body.code).toBe('FINANCE_REFUND_ID_REUSED');

    const stillConfirmed = await bookingApi(customer).post(
      '/bookings/' + confirmed.bookingReference + '/cancel',
      {},
    );
    expect(stillConfirmed.status).toBe(409);
    expect(stillConfirmed.body.code).toBe('BOOKING_CONFIRMED');

    const tooMuch = await financePost(
      finance,
      '/payments/' + confirmed.paymentReference + '/refunds',
      {
        clientRefundId: 'refund-test-0002',
        amountMinor: String(confirmed.amountMinor),
        reason: 'Tentative de sur-remboursement',
      },
    );
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.code).toBe('FINANCE_REFUND_EXCEEDS_PAYMENT');

    const remainder = confirmed.amountMinor - firstAmount;
    const finalRefund = await financePost(
      finance,
      '/payments/' + confirmed.paymentReference + '/refunds',
      {
        clientRefundId: 'refund-test-0003',
        amountMinor: String(remainder),
        reason: 'Solde du remboursement de test',
      },
    );
    expect(finalRefund.status, finalRefund.text).toBe(201);

    const cancelled = await bookingApi(customer).post(
      '/bookings/' + confirmed.bookingReference + '/cancel',
      {},
    );
    expect(cancelled.status, cancelled.text).toBe(200);

    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: confirmed.bookingReference },
      include: { seats: true },
    });
    expect(booking.cancelledAt).toBeTruthy();
    expect(booking.seats.every((seat) => seat.releasedAt !== null)).toBe(true);
    expect(
      await db(t.app).seatInventoryLock.count({
        where: { tripId: fixture.tripId, bookingSeat: { bookingId: booking.id } },
      }),
    ).toBe(0);
    expect(
      (
        await db(t.app).payment.findUniqueOrThrow({
          where: { reference: confirmed.paymentReference },
        })
      ).status,
    ).toBe('SUCCEEDED');
    expect(
      await db(t.app).creditNote.count({
        where: { refund: { payment: { reference: confirmed.paymentReference } } },
      }),
    ).toBe(2);
  });

  it('serializes concurrent refunds and prevents over-refund', async () => {
    const fixture = await bookableFixture(t.app);
    const confirmed = await createConfirmedBooking(fixture, ['2A']);
    const amount = Math.floor((confirmed.amountMinor * 3) / 4);

    const [a, b] = await Promise.all([
      financePost(finance, '/payments/' + confirmed.paymentReference + '/refunds', {
        clientRefundId: 'refund-race-0001',
        amountMinor: String(amount),
        reason: 'Course remboursement A',
      }),
      financePost(finance, '/payments/' + confirmed.paymentReference + '/refunds', {
        clientRefundId: 'refund-race-0002',
        amountMinor: String(amount),
        reason: 'Course remboursement B',
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a.body.code, b.body.code].filter(Boolean)).toEqual(['FINANCE_REFUND_EXCEEDS_PAYMENT']);
    const total = await db(t.app).refund.aggregate({
      where: { payment: { reference: confirmed.paymentReference } },
      _sum: { amountMinor: true },
    });
    expect(total._sum.amountMinor).toBe(BigInt(amount));
  });

  it('lets trip cancellation cascade through fully refunded confirmed bookings', async () => {
    const fixture = await bookableFixture(t.app);
    const confirmed = await createConfirmedBooking(fixture, ['2B']);

    const blocked = await adminApi(manager).post('/trips/' + fixture.tripId + '/cancel', {
      reason: 'Annulation voyage avant remboursement',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('TRIP_HAS_CONFIRMED_BOOKINGS');

    const refunded = await financePost(
      finance,
      '/payments/' + confirmed.paymentReference + '/refunds',
      {
        clientRefundId: 'refund-trip-0001',
        amountMinor: String(confirmed.amountMinor),
        reason: 'Remboursement intégral avant annulation voyage',
      },
    );
    expect(refunded.status, refunded.text).toBe(201);

    const cancelled = await adminApi(manager).post('/trips/' + fixture.tripId + '/cancel', {
      reason: 'Annulation voyage après remboursement',
    });
    expect(cancelled.status, cancelled.text).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: confirmed.bookingReference },
    });
    expect(booking.cancelledAt).toBeTruthy();
  });
});
