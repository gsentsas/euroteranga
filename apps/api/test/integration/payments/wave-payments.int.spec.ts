import { createHash } from 'node:crypto';
import type { ApiEnv } from '@euroteranga/config';
import { createLogger } from '@euroteranga/logger';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WavePaymentProvider } from '../../../src/payments/providers/wave-payment.provider.js';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  syntheticCountry,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import {
  idempotencyKey,
  insertIdentityQuote,
  paymentApi,
  shortHold,
  waitUntilExpired,
} from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';
import {
  FakeWaveGateway,
  syntheticWaveWebhookSecret,
  waveCheckoutEvent,
  waveWebhookSignature,
} from '../../support/wave-helpers.js';

const UNIT = 12_450;
const WAVE_WEBHOOK = '/v1/payments/webhooks/wave';

describe('Wave Senegal direct adapter (PostgreSQL, fake Wave gateway)', () => {
  let t: TestApp;
  let env: ApiEnv;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let alice: CustomerActor;
  const gateway = new FakeWaveGateway();
  const webhookSecret = syntheticWaveWebhookSecret();
  const logger = createLogger({
    service: 'wave-integration-test',
    level: 'error',
    write: () => {},
  });
  const provider = new WavePaymentProvider({
    gateway,
    webhookSecret,
    returnUrl: 'https://client.example.test/compte',
    logger,
  });

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({
      DATABASE_URL: database.url,
      PAYMENT_PROVIDER: 'DISABLED',
      BOOKING_HOLD_TTL_SECONDS: '3600',
    });
    // The complete provider is injected only into this test module. Runtime
    // config remains DISABLED, so CI has no key and cannot reach Wave.
    t = await startTestApp(env, [], { testPaymentProviders: [provider] });
    countryId = await syntheticCountry(t.app);
    alice = await customerActor(t.app);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    gateway.onCreate = null;
    gateway.failNext = null;
    gateway.failAfterCreate = null;
    gateway.override = {};
    gateway.expireResult = 'EXPIRED';
    gateway.statusAfterConflict = { checkout_status: 'expired', payment_status: 'cancelled' };
  });

  const prisma = () => db(t.app);
  const fixture = () =>
    bookableFixture(t.app, {
      countryId,
      amount: () => UNIT,
      currencyCode: 'XOF',
      currencyMinorUnit: 0,
    });
  const hold = async (seats = ['1A', '1B']) => {
    const f = await fixture();
    const response = await bookingApi(alice).post('/bookings', holdBody(f, 1, 2, seats));
    expect(response.status).toBe(201);
    return response.body.reference as string;
  };
  const optionsOf = async (reference: string) => {
    const response = await paymentApi(alice).options(reference, 'SN');
    expect(response.status).toBe(200);
    return Object.fromEntries(
      (response.body.methods as Array<{ code: string; available: boolean }>).map((method) => [
        method.code,
        method,
      ]),
    );
  };
  const start = async (key = idempotencyKey()) => {
    const reference = await hold();
    const quoted = await paymentApi(alice).quote(reference, {
      payerCountry: 'SN',
      paymentMethod: 'WAVE_SN',
    });
    expect(quoted.status).toBe(201);
    const created = await paymentApi(alice).create(reference, {
      key,
      body: { quoteId: quoted.body.id, paymentMethod: 'WAVE_SN' },
    });
    expect(created.status).toBe(201);
    const payment = await prisma().payment.findUniqueOrThrow({
      where: { reference: created.body.payment.reference },
      include: { booking: true, events: true },
    });
    return { reference, quote: quoted.body, created, payment, key };
  };
  const rawFor = (
    payment: { reference: string; providerPaymentId: string | null },
    amount: string,
    overrides: Partial<Parameters<typeof waveCheckoutEvent>[0]> = {},
  ) =>
    waveCheckoutEvent({
      sessionId: payment.providerPaymentId!,
      paymentReference: payment.reference,
      amount,
      ...overrides,
    });
  const send = (
    raw: string,
    options: { signature?: string | null; contentType?: string; timestampOffset?: number } = {},
  ) => {
    const timestamp = Math.floor(Date.now() / 1000) + (options.timestampOffset ?? 0);
    const signature =
      options.signature === undefined
        ? waveWebhookSignature(raw, webhookSecret, timestamp)
        : options.signature;
    let call = request(t.app.getHttpServer())
      .post(WAVE_WEBHOOK)
      .set('Content-Type', options.contentType ?? 'application/json; charset=utf-8');
    if (signature !== null) call = call.set('Wave-Signature', signature);
    return call.send(raw);
  };
  const reload = (id: string) =>
    prisma().payment.findUniqueOrThrow({ where: { id }, include: { booking: true, events: true } });

  it('offers Wave only when the backend can route it; Orange and aggregators stay unavailable', async () => {
    const reference = await hold();
    const options = await optionsOf(reference);
    expect(options.WAVE_SN).toMatchObject({ available: true });
    for (const method of [
      'ORANGE_MONEY_SN',
      'FREE_MONEY_SN',
      'EXPRESSO_SN',
      'WIZALL_SN',
      'DJAMO_SN',
      'CARD',
      'PAYPAL',
    ]) {
      expect(options[method], method).toMatchObject({ available: false });
    }
    const orange = await paymentApi(alice).quote(reference, {
      payerCountry: 'SN',
      paymentMethod: 'ORANGE_MONEY_SN',
    });
    expect(orange.status).toBe(409);
    expect(orange.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
  });

  it('commits PENDING before the fake provider call, outside a DB transaction, then stores its id', async () => {
    const seen: Array<{
      status: string | undefined;
      providerId: string | null | undefined;
      open: number;
    }> = [];
    gateway.onCreate = async () => {
      const [row] = await prisma().payment.findMany({
        where: { provider: 'WAVE' },
        orderBy: { id: 'desc' },
        take: 1,
      });
      const [open] = await prisma().$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS "count" FROM pg_stat_activity
        WHERE datname = current_database() AND state LIKE 'idle in transaction%'`;
      seen.push({
        status: row?.status,
        providerId: row?.providerPaymentId,
        open: Number(open!.count),
      });
    };
    const calls = gateway.createCalls.length;
    const { quote, created, payment, reference } = await start();
    expect(seen).toEqual([{ status: 'PENDING', providerId: null, open: 0 }]);
    expect(gateway.createCalls[calls]!.input).toMatchObject({
      amount: String(quote.presentment.amountMinor),
      currency: 'XOF',
      client_reference: payment.reference,
    });
    expect(payment.providerPaymentId).toBe(FakeWaveGateway.sessionIdFor(payment.reference));
    expect(created.body.checkout).toEqual({
      provider: 'WAVE',
      testMode: false,
      redirectUrl: `https://pay.wave.com/c/${payment.providerPaymentId}`,
    });
    // A browser return is only navigation: listing the payment cannot confirm it.
    expect((await paymentApi(alice).list(reference)).body.items[0].status).toBe('PENDING');
    expect((await reload(payment.id)).status).toBe('PENDING');
  });

  it('recovers an unknown provider response and never creates a second checkout', async () => {
    gateway.failAfterCreate = new Error('synthetic response lost');
    const calls = gateway.createCalls.length;
    const started = await start();
    expect(started.payment.status).toBe('PENDING');
    expect(gateway.createCalls).toHaveLength(calls + 1);
    expect(gateway.searchCalls.filter((item) => item === started.payment.reference)).toHaveLength(
      2,
    );

    const replay = await paymentApi(alice).create(started.reference, {
      key: started.key,
      body: { quoteId: started.quote.id, paymentMethod: 'WAVE_SN' },
    });
    expect(replay.status).toBe(200);
    expect(gateway.createCalls).toHaveLength(calls + 1);
  });

  it('keeps a timed-out create PENDING so the same reference can be reconciled', async () => {
    const reference = await hold();
    const quote = await paymentApi(alice).quote(reference, {
      payerCountry: 'SN',
      paymentMethod: 'WAVE_SN',
    });
    const key = idempotencyKey();
    gateway.onCreate = async () => {
      gateway.failNext = new Error('synthetic timeout before commit');
    };
    const failed = await paymentApi(alice).create(reference, {
      key,
      body: { quoteId: quote.body.id, paymentMethod: 'WAVE_SN' },
    });
    expect(failed.status).toBe(503);
    const pending = await prisma().payment.findFirstOrThrow({ where: { booking: { reference } } });
    expect(pending).toMatchObject({ status: 'PENDING', providerPaymentId: null, provider: 'WAVE' });

    gateway.onCreate = null;
    const replay = await paymentApi(alice).create(reference, {
      key,
      body: { quoteId: quote.body.id, paymentMethod: 'WAVE_SN' },
    });
    expect(replay.status).toBe(200);
    expect((await reload(pending.id)).providerPaymentId).toBe(
      FakeWaveGateway.sessionIdFor(pending.reference),
    );
  });

  it('confirms exactly once from a signed exact event and stores only its hash', async () => {
    const { payment, quote, reference } = await start();
    const raw = rawFor(payment, String(quote.presentment.amountMinor));
    const first = await send(raw);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true, outcome: 'PAYMENT_SUCCEEDED' });
    const after = await reload(payment.id);
    expect(after.status).toBe('SUCCEEDED');
    expect(after.booking.confirmedAt).not.toBeNull();
    expect(after.events).toHaveLength(1);
    expect(after.events[0]!.payloadHash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect((await bookingApi(alice).get(`/bookings/${reference}`)).body.status).toBe('CONFIRMED');

    expect((await send(raw)).body.outcome).toBe('DUPLICATE');
    const parsed = JSON.parse(raw) as { id: string };
    const conflict = await send(
      rawFor(payment, String(quote.presentment.amountMinor + 1), { eventId: parsed.id }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('PAYMENT_WEBHOOK_REPLAY');
    expect(
      await prisma().auditEvent.count({
        where: { action: 'BOOKING_CONFIRMED', resourceId: payment.bookingId },
      }),
    ).toBe(1);
  });

  it.each([
    ['amount', (amount: number) => ({ amount: String(amount + 1) })],
    ['currency', () => ({ currency: 'EUR' })],
  ] as const)('records and rejects a wrong %s without confirmation', async (_label, change) => {
    const { payment, quote } = await start();
    const amount = quote.presentment.amountMinor as number;
    const response = await send(rawFor(payment, String(amount), change(amount)));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: 'REJECTED', code: 'PAYMENT_WEBHOOK_INVALID' });
    const after = await reload(payment.id);
    expect(after.status).toBe('PENDING');
    expect(after.booking.confirmedAt).toBeNull();
  });

  it('rejects a wrong client_reference and an unknown checkout', async () => {
    const { payment, quote } = await start();
    const wrongReference = await send(
      rawFor(payment, String(quote.presentment.amountMinor), {
        paymentReference: 'ETP-ZYXWVTSRQPNM',
      }),
    );
    expect(wrongReference.status).toBe(422);
    expect(wrongReference.body.code).toBe('PAYMENT_WEBHOOK_INVALID');
    expect((await reload(payment.id)).events).toHaveLength(0);

    const unknown = waveCheckoutEvent({
      sessionId: 'cos-1234567890abcdef',
      paymentReference: payment.reference,
      amount: String(quote.presentment.amountMinor),
    });
    expect((await send(unknown)).status).toBe(404);
  });

  it('ignores authentic attempt failures because Wave may later succeed', async () => {
    const { payment, quote } = await start();
    const failed = await send(
      rawFor(payment, String(quote.presentment.amountMinor), {
        type: 'checkout.session.payment_failed',
        paymentStatus: 'failed',
        checkoutStatus: 'failed',
      }),
    );
    expect(failed.body).toEqual({ received: true, outcome: 'IGNORED' });
    expect(await reload(payment.id)).toMatchObject({ status: 'PENDING', events: [] });
  });

  it('fails closed when success arrives after the booking hold expired', async () => {
    const f = await fixture();
    const expiring = await shortHold(t.app, f, alice.id, 1, 2, ['2A'], 3_000);
    const quote = await insertIdentityQuote(prisma(), expiring.id);
    const booking = await prisma().booking.findUniqueOrThrow({ where: { id: expiring.id } });
    const providerPaymentId = 'cos-latesuccess0001';
    const payment = await prisma().payment.create({
      data: {
        reference: 'ETP-ABCDEFGH2345',
        bookingId: booking.id,
        customerIdentityId: alice.id,
        quoteId: quote.id,
        provider: 'WAVE',
        providerPaymentId,
        amountMinor: BigInt(UNIT),
        currencyCode: booking.currencyCode,
        currencyMinorUnit: booking.currencyMinorUnit,
      },
    });
    await waitUntilExpired(t.app, expiring.id);
    const response = await send(
      waveCheckoutEvent({
        sessionId: providerPaymentId,
        paymentReference: payment.reference,
        amount: String(UNIT),
      }),
    );
    expect(response.body).toMatchObject({ outcome: 'REJECTED', code: 'PAYMENT_BOOKING_EXPIRED' });
    expect(await reload(payment.id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'BOOKING_EXPIRED',
    });
  });

  it('expires Wave before local cancellation and refuses blind/late cancellation', async () => {
    const first = await start();
    const cancelled = await paymentApi(alice).cancel(first.payment.reference);
    expect(cancelled.status).toBe(200);
    expect(gateway.expireCalls.at(-1)).toBe(first.payment.providerPaymentId);
    expect((await reload(first.payment.id)).status).toBe('CANCELLED');
    const lateCancelled = await send(
      rawFor(first.payment, String(first.quote.presentment.amountMinor)),
    );
    expect(lateCancelled.body).toMatchObject({
      outcome: 'REJECTED',
      code: 'PAYMENT_INVALID_TRANSITION',
    });
    expect((await reload(first.payment.id)).status).toBe('CANCELLED');

    const completed = await start();
    gateway.expireResult = 'CONFLICT';
    gateway.statusAfterConflict = { checkout_status: 'complete', payment_status: 'succeeded' };
    const refused = await paymentApi(alice).cancel(completed.payment.reference);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PAYMENT_PROVIDER_COMPLETING');
    expect((await reload(completed.payment.id)).status).toBe('PENDING');

    const unknown = await start();
    gateway.failNext = new Error('synthetic timeout');
    expect((await paymentApi(alice).cancel(unknown.payment.reference)).status).toBe(503);
    expect((await reload(unknown.payment.id)).status).toBe('PENDING');
  });

  it('persists no phone, OTP, raw payload or provider secret', async () => {
    const { payment, quote, reference } = await start();
    await send(rawFor(payment, String(quote.presentment.amountMinor)));
    const columns = await prisma().$queryRaw<Array<{ column: string }>>`
      SELECT column_name AS "column" FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('payment', 'payment_event', 'payment_quote')`;
    expect(columns.map((item) => item.column).join(' ')).not.toMatch(
      /phone|msisdn|otp|pin|payload(?!_hash)|raw/i,
    );
    const customer = JSON.stringify((await paymentApi(alice).list(reference)).body);
    expect(customer).not.toContain('cos-');
    expect(customer).not.toContain(webhookSecret);
    expect(t.logs.raw.join('\n')).not.toContain(webhookSecret);
    expect(t.logs.raw.join('\n')).not.toContain('checkout.session.completed');
  });
});

describe('Wave disabled by default', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(
      integrationEnv({ DATABASE_URL: database.url, PAYMENT_PROVIDER: 'DISABLED' }),
    );
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  it('has no Wave or Orange webhook adapter and makes no provider call', async () => {
    const response = await request(t.app.getHttpServer())
      .post(WAVE_WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('Wave-Signature', 't=1,v1=0')
      .send('{}');
    expect(response.status).toBe(404);
  });
});
