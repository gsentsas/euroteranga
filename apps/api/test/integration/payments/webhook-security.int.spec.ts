import { createHmac, randomBytes } from 'node:crypto';
import type { ApiEnv } from '@euroteranga/config';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, withoutRequestId } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import {
  paymentApi,
  providerPaymentIdOf,
  sandboxEvent,
  sendWebhook,
  WEBHOOK_PATH,
} from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * The SANDBOX webhook is authenticated by an HMAC over the raw body, never by
 * a session. Every forged, stale, oversized, replayed or inconsistent event
 * fails cleanly and changes nothing.
 */
describe('payment webhook security', () => {
  let t: TestApp;
  let env: ApiEnv;
  let alice: CustomerActor;

  beforeAll(async () => {
    env = integrationEnv();
    t = await startTestApp(env);
    alice = await customerActor(t.app);
  });

  afterAll(async () => {
    await t.app.close();
  });

  /** A PENDING attempt and a valid success event for it (not yet sent). */
  async function pendingAttempt(amount = 1000) {
    const f = await bookableFixture(t.app, { amount: () => amount });
    const hold = await bookingApi(alice).post('/bookings', holdBody(f, 1, 2, ['1A']));
    const attempt = await paymentApi(alice).create(hold.body.reference as string);
    expect(attempt.status).toBe(201);
    const reference = attempt.body.payment.reference as string;
    const providerPaymentId = await providerPaymentIdOf(t.app, reference);
    const raw = sandboxEvent({
      type: 'payment.succeeded',
      providerPaymentId,
      amountMinor: amount,
      currency: 'EUR',
    });
    return { reference, bookingReference: hold.body.reference as string, providerPaymentId, raw };
  }

  async function unchanged(attempt: { reference: string; bookingReference: string }) {
    const payment = await db(t.app).payment.findUniqueOrThrow({
      where: { reference: attempt.reference },
      include: { events: true },
    });
    expect(payment.status).toBe('PENDING');
    const booking = await db(t.app).booking.findUniqueOrThrow({
      where: { reference: attempt.bookingReference },
    });
    expect(booking.confirmedAt).toBeNull();
    return payment.events;
  }

  const expectInvalid = (response: request.Response, status: number) => {
    expect(response.status).toBe(status);
    expect(withoutRequestId(response.body)).toEqual({
      code: 'PAYMENT_WEBHOOK_INVALID',
      message: 'Événement de paiement refusé.',
    });
  };

  it('refuses a missing, malformed or wrong signature, without a session either', async () => {
    const attempt = await pendingAttempt();
    expectInvalid(await sendWebhook(t.app, env, attempt.raw, { signature: null }), 401);
    expectInvalid(await sendWebhook(t.app, env, attempt.raw, { signature: 'garbage' }), 401);
    const now = Math.floor(Date.now() / 1000);
    expectInvalid(
      await sendWebhook(t.app, env, attempt.raw, { signature: `t=${now},v1=${'0'.repeat(64)}` }),
      401,
    );
    // Signed with another key (right shape, right length).
    const otherKey = randomBytes(32);
    const forged = createHmac('sha256', otherKey).update(`${now}.${attempt.raw}`).digest('hex');
    expectInvalid(
      await sendWebhook(t.app, env, attempt.raw, { signature: `t=${now},v1=${forged}` }),
      401,
    );
    // A customer session and CSRF token are no substitute for the signature.
    const csrf = await alice.csrf();
    const withSession = await request(t.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Cookie', alice.cookie)
      .set('X-CSRF-Token', csrf)
      .send(attempt.raw);
    expectInvalid(withSession, 401);
    expect(await unchanged(attempt)).toHaveLength(0);
  });

  it('refuses stale or future timestamps and a timestamp not covered by the signature', async () => {
    const attempt = await pendingAttempt();
    const now = Math.floor(Date.now() / 1000);
    expectInvalid(await sendWebhook(t.app, env, attempt.raw, { timestamp: now - 301 }), 401);
    expectInvalid(await sendWebhook(t.app, env, attempt.raw, { timestamp: now + 301 }), 401);
    const signed = await sendWebhook(t.app, env, attempt.raw, { timestamp: now - 10 });
    const header = signed.request.getHeader('ET-Sandbox-Signature') as string;
    const moved = header.replace(/^t=\d+/, `t=${now}`);
    expectInvalid(await sendWebhook(t.app, env, attempt.raw, { signature: moved }), 401);
    expect(signed.status).toBe(200);
  });

  it('refuses an altered payload', async () => {
    const attempt = await pendingAttempt(1000);
    const tampered = attempt.raw.replace('"amountMinor":1000', '"amountMinor":1');
    expect(tampered).not.toBe(attempt.raw);
    expectInvalid(await sendWebhook(t.app, env, tampered, { signedBody: attempt.raw }), 401);
    expectInvalid(
      await sendWebhook(t.app, env, `${attempt.raw} `, { signedBody: attempt.raw }),
      401,
    );
    expect(await unchanged(attempt)).toHaveLength(0);
  });

  it('refuses other content types and oversized payloads', async () => {
    const attempt = await pendingAttempt();
    expectInvalid(await sendWebhook(t.app, env, attempt.raw, { contentType: 'text/plain' }), 415);
    expectInvalid(
      await sendWebhook(t.app, env, attempt.raw, {
        contentType: 'application/x-www-form-urlencoded',
      }),
      415,
    );
    // Above the 8 KiB webhook limit (signed, otherwise valid JSON).
    const big = JSON.stringify({ ...JSON.parse(attempt.raw), padding: 'x'.repeat(9_000) });
    expectInvalid(await sendWebhook(t.app, env, big), 413);
    // Above the global 32 KiB body limit: refused before any parsing.
    const huge = JSON.stringify({ ...JSON.parse(attempt.raw), padding: 'x'.repeat(40_000) });
    const tooLarge = await sendWebhook(t.app, env, huge);
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await unchanged(attempt)).toHaveLength(0);
  });

  it('refuses signed payloads outside the event schema', async () => {
    const attempt = await pendingAttempt();
    const base = JSON.parse(attempt.raw) as {
      id: string;
      type: string;
      data: Record<string, unknown>;
    };
    for (const payload of [
      { ...base, type: 'payment.refunded' },
      { ...base, id: 'not-an-event-id' },
      { ...base, extra: true },
      { ...base, data: { ...base.data, amountMinor: 10.5 } },
      { ...base, data: { ...base.data, amountMinor: -1 } },
      { ...base, data: { ...base.data, currency: 'eur' } },
      { ...base, data: { ...base.data, cardNumber: '4111111111111111' } },
      { ...base, data: { ...base.data, failureReason: 'declined' } },
    ]) {
      expectInvalid(await sendWebhook(t.app, env, JSON.stringify(payload)), 400);
    }
    expect(await unchanged(attempt)).toHaveLength(0);
  });

  it('reports an unknown payment and refuses replays', async () => {
    const unknown = sandboxEvent({
      type: 'payment.succeeded',
      providerPaymentId: 'sbx_unknownunknownunknown',
      amountMinor: 1000,
      currency: 'EUR',
    });
    const notFound = await sendWebhook(t.app, env, unknown);
    expect(notFound.status).toBe(404);
    expect(notFound.body.code).toBe('PAYMENT_NOT_FOUND');

    const attempt = await pendingAttempt();
    expect((await sendWebhook(t.app, env, attempt.raw)).status).toBe(200);
    // The very same signed request, replayed (within the timestamp window).
    const replay = await sendWebhook(t.app, env, attempt.raw);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('PAYMENT_WEBHOOK_REPLAY');
    // The same event id with another body is still a replay.
    const sameId = JSON.stringify({ ...JSON.parse(attempt.raw), type: 'payment.failed' });
    expect((await sendWebhook(t.app, env, sameId)).body.code).toBe('PAYMENT_WEBHOOK_REPLAY');
    const payment = await db(t.app).payment.findUniqueOrThrow({
      where: { reference: attempt.reference },
      include: { events: true },
    });
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.events).toHaveLength(1);
  });

  it('records but never applies an event whose amount or currency differs', async () => {
    const attempt = await pendingAttempt(1000);
    const event = (amountMinor: number, currency: string) =>
      sandboxEvent({
        type: 'payment.succeeded',
        providerPaymentId: attempt.providerPaymentId,
        amountMinor,
        currency,
      });
    expectInvalid(await sendWebhook(t.app, env, event(999, 'EUR')), 422);
    expectInvalid(await sendWebhook(t.app, env, event(1000, 'XOF')), 422);
    const events = await unchanged(attempt);
    expect(events.map((recorded) => [recorded.processedAt, recorded.rejectionCode])).toEqual([
      [null, 'AMOUNT_MISMATCH'],
      [null, 'CURRENCY_MISMATCH'],
    ]);
    // The genuine event still confirms the booking afterwards.
    expect((await sendWebhook(t.app, env, attempt.raw)).status).toBe(200);
  });

  it('never echoes the key or the signature, in responses or logs', async () => {
    const attempt = await pendingAttempt();
    const responses = [
      await sendWebhook(t.app, env, attempt.raw, { signature: 'garbage' }),
      await sendWebhook(t.app, env, attempt.raw),
    ];
    const signature = responses[1]!.request.getHeader('ET-Sandbox-Signature') as string;
    const secret = env.PAYMENT_SANDBOX_WEBHOOK_SECRET!;
    for (const response of responses) {
      expect(JSON.stringify(response.body)).not.toContain(secret);
      expect(JSON.stringify(response.body)).not.toContain(signature.slice(-64));
    }
    const logs = t.logs.raw.join('\n');
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain(signature.slice(-64));
  });
});

describe('payments disabled (PAYMENT_PROVIDER=DISABLED)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp(integrationEnv({ PAYMENT_PROVIDER: 'DISABLED' }));
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('refuses initiation and exposes no webhook', async () => {
    const alice = await customerActor(t.app);
    const f = await bookableFixture(t.app);
    const hold = await bookingApi(alice).post('/bookings', holdBody(f, 1, 2, ['1A']));
    const attempt = await paymentApi(alice).create(hold.body.reference as string);
    expect(attempt.status).toBe(503);
    expect(attempt.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    const webhook = await request(t.app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(webhook.status).toBe(404);
    expect(await db(t.app).payment.count({ where: { booking: { tripId: f.tripId } } })).toBe(0);
  });
});
