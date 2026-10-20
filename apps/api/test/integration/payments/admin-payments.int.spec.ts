import type { ApiEnv } from '@euroteranga/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../../src/authorization/permissions.js';
import {
  adminApi,
  createTestRole,
  staffActor,
  type StaffActor,
} from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { paymentApi, settle } from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * STAFF reading of payments (payment.read) and the single mutation allowed
 * (payment.manage: give up a PENDING attempt). There is no "mark paid".
 */
describe('admin payments', () => {
  let t: TestApp;
  let env: ApiEnv;
  let alice: CustomerActor;
  let finance: StaffActor;
  let agent: StaffActor;

  beforeAll(async () => {
    env = integrationEnv();
    t = await startTestApp(env);
    [alice, finance, agent] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['FINANCE']),
      staffActor(t.app, ['BOOKING_AGENT']),
    ]);
  });

  afterAll(async () => {
    await t.app.close();
  });

  /** A booking of alice with one PENDING attempt (and optionally settled). */
  async function attempt(seat = '1A', outcome?: 'payment.succeeded' | 'payment.failed') {
    const f = await bookableFixture(t.app, { amount: () => 7_500 });
    const hold = await bookingApi(alice).post('/bookings', holdBody(f, 1, 3, [seat]));
    const created = await paymentApi(alice).create(hold.body.reference as string);
    expect(created.status).toBe(201);
    if (outcome) expect((await settle(t.app, env, created.body.payment, outcome)).status).toBe(200);
    const payment = await db(t.app).payment.findUniqueOrThrow({
      where: { reference: created.body.payment.reference as string },
    });
    return { f, bookingReference: hold.body.reference as string, payment };
  }

  it('lists and filters attempts for payment.read, newest first with keyset pages', async () => {
    const pending = await attempt();
    const succeeded = await attempt('1B', 'payment.succeeded');
    const failed = await attempt('2A', 'payment.failed');
    const api = adminApi(agent);
    const byReference = await api.get(
      `/payments?paymentReference=${succeeded.payment.reference.toLowerCase()}`,
    );
    expect(byReference.status).toBe(200);
    expect(byReference.body.items).toEqual([
      {
        id: succeeded.payment.id,
        reference: succeeded.payment.reference,
        status: 'SUCCEEDED',
        provider: 'SANDBOX',
        providerPaymentId: succeeded.payment.providerPaymentId,
        booking: {
          id: succeeded.payment.bookingId,
          reference: succeeded.bookingReference,
          status: 'CONFIRMED',
        },
        customerIdentityId: alice.id,
        amountMinor: 7_500,
        currencyCode: 'EUR',
        currencyMinorUnit: 2,
        // PAY-HUB-1: the quote the attempt was started from (an identity quote).
        paymentMethod: 'CARD',
        payerCountry: 'FR',
        presentment: { amountMinor: 7_500, currencyCode: 'EUR', currencyMinorUnit: 2 },
        quote: {
          id: expect.any(String),
          fxRate: '1',
          fxSource: 'FX_IDENTITY',
          quotedAt: expect.any(String),
          expiresAt: expect.any(String),
        },
        failureCode: null,
        createdAt: expect.any(String),
        succeededAt: expect.any(String),
        failedAt: null,
        cancelledAt: null,
      },
    ]);
    expect(JSON.stringify(byReference.body)).not.toContain(alice.email);
    const byBooking = await api.get(`/payments?bookingReference=${failed.bookingReference}`);
    expect(byBooking.body.items).toMatchObject([{ status: 'FAILED', failureCode: 'UNKNOWN' }]);
    const pendingOnly = await api.get('/payments?status=PENDING&limit=100');
    expect(pendingOnly.body.items.map((item: { id: string }) => item.id)).toContain(
      pending.payment.id,
    );
    expect(
      pendingOnly.body.items.every((item: { status: string }) => item.status === 'PENDING'),
    ).toBe(true);
    const first = await api.get('/payments?limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items[0].id > first.body.items[1].id).toBe(true);
    const next = await api.get(`/payments?limit=2&cursor=${first.body.nextCursor}`);
    expect(next.body.items[0].id < first.body.items[1].id).toBe(true);
    expect((await api.get('/payments?status=PAID')).status).toBe(400);
    expect((await api.get('/payments/not-a-uuid')).status).toBe(400);
  });

  it('shows one attempt with its provider event timeline, never a payload', async () => {
    const succeeded = await attempt('2B', 'payment.succeeded');
    const detail = await adminApi(finance).get(`/payments/${succeeded.payment.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: succeeded.payment.id, status: 'SUCCEEDED' });
    expect(detail.body.events).toEqual([
      {
        id: expect.any(String),
        type: 'PAYMENT_SUCCEEDED',
        providerEventId: expect.stringMatching(/^evt_/),
        receivedAt: expect.any(String),
        processedAt: expect.any(String),
        rejectionCode: null,
      },
    ]);
    expect(JSON.stringify(detail.body)).not.toMatch(/payloadHash|payload"|signature|secret/i);
    const unknown = await adminApi(finance).get('/payments/01900000-0000-7000-8000-000000000000');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('PAYMENT_NOT_FOUND');
  });

  it('lets payment.manage give up a PENDING attempt with a reason, never mark one paid', async () => {
    const pending = await attempt();
    // BOOKING_AGENT reads payments but cannot manage them.
    const refused = await adminApi(agent).post(`/payments/${pending.payment.id}/cancel`, {
      reason: 'Essai',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(
      (await adminApi(finance).post(`/payments/${pending.payment.id}/cancel`, {})).status,
    ).toBe(400);
    expect(
      (
        await adminApi(finance).post(
          `/payments/${pending.payment.id}/cancel`,
          { reason: 'x' },
          { csrf: null },
        )
      ).status,
    ).toBe(403);
    const cancelled = await adminApi(finance).post(`/payments/${pending.payment.id}/cancel`, {
      reason: 'Tentative bloquée côté prestataire',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', booking: { status: 'HELD' } });
    const audit = await db(t.app).auditEvent.findFirstOrThrow({
      where: { action: 'PAYMENT_CANCELLED', resourceId: pending.payment.id },
    });
    expect(audit).toMatchObject({ actorIdentityId: finance.id, actorRealm: 'STAFF' });
    expect(audit.metadata).toMatchObject({
      cancelledBy: 'STAFF',
      reason: 'Tentative bloquée côté prestataire',
    });
    const again = await adminApi(finance).post(`/payments/${pending.payment.id}/cancel`, {
      reason: 'Encore',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PAYMENT_INVALID_TRANSITION');

    // No route can make an attempt SUCCEEDED: only a provider event does.
    const other = await attempt('1B');
    for (const path of ['succeed', 'mark-paid', 'confirm', 'success', 'status']) {
      const response = await adminApi(finance).post(`/payments/${other.payment.id}/${path}`, {
        status: 'SUCCEEDED',
      });
      expect(response.status, path).toBe(404);
    }
    const customerTry = await bookingApi(alice).post(
      `/payments/${other.payment.reference}/succeed`,
    );
    expect(customerTry.status).toBe(404);
    expect(
      (await db(t.app).payment.findUniqueOrThrow({ where: { id: other.payment.id } })).status,
    ).toBe('PENDING');
  });

  it('refuses roles without payment.read, and payment details stay behind it', async () => {
    const confirmed = await attempt('2A', 'payment.succeeded');
    for (const role of ['DISPATCHER', 'COMPLIANCE_AGENT']) {
      const api = adminApi(await staffActor(t.app, [role]));
      expect((await api.get('/payments')).status, role).toBe(403);
      expect((await api.get(`/payments/${confirmed.payment.id}`)).status, role).toBe(403);
    }
    // booking.read without payment.read: the booking, but no payment detail.
    const bookingOnly = await createTestRole(t.app, [
      PERMISSIONS.OPS_ACCESS,
      PERMISSIONS.BOOKING_READ,
    ]);
    const reader = adminApi(await staffActor(t.app, [bookingOnly]));
    const minimized = await reader.get(`/bookings/${confirmed.payment.bookingId}`);
    expect(minimized.status).toBe(200);
    expect(minimized.body).toMatchObject({ status: 'CONFIRMED', confirmedAt: expect.any(String) });
    expect(minimized.body).not.toHaveProperty('payments');
    expect(JSON.stringify(minimized.body)).not.toMatch(/ETP-|sbx_|providerPaymentId/);
    expect((await reader.get('/payments')).status).toBe(403);
    // BOOKING_AGENT holds payment.read: the attempts come with the booking.
    const full = await adminApi(agent).get(`/bookings/${confirmed.payment.bookingId}`);
    expect(full.body.payments).toMatchObject([
      { reference: confirmed.payment.reference, status: 'SUCCEEDED', amountMinor: 7_500 },
    ]);
    // CONFIRMED is a booking list filter.
    const list = await adminApi(agent).get(
      `/bookings?status=CONFIRMED&reference=${confirmed.bookingReference}`,
    );
    expect(list.body.items).toMatchObject([
      { reference: confirmed.bookingReference, status: 'CONFIRMED' },
    ]);
    expect(list.body.items[0]).not.toHaveProperty('payments');
  });
});
