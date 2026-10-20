import type { ApiEnv } from '@euroteranga/config';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  declaredCapability,
  PaymentCapabilityRegistry,
} from '../../../src/payments/payment-capability.registry.js';
import {
  methodsForCountry,
  type PaymentMethodCode,
  type PaymentProviderCode,
} from '../../../src/payments/payment-catalog.js';
import { PaymentFxService } from '../../../src/payments/payment-fx.service.js';
import { PaymentWebhookService } from '../../../src/payments/payment-webhook.service.js';
import type {
  PaymentProvider,
  ProviderCapability,
  ProviderPaymentRequest,
} from '../../../src/payments/providers/payment-provider.js';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  holdBody,
  syntheticCountry,
  type BookableFixture,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import {
  idempotencyKey,
  insertIdentityQuote,
  paymentApi,
  sandboxEvent,
  sendWebhook,
  settle,
} from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/** 2 seats x 124.50 EUR = 249.00 EUR = 163 333 XOF at the synthetic CI rate. */
const UNIT = 12_450;
const TOTAL = 24_900;
const XOF_TOTAL = 163_333;

/** A synthetic adapter: no network; records what it is asked to collect. */
function fakeProvider(name: PaymentProviderCode, methods: PaymentMethodCode[], priority: number) {
  const calls: ProviderPaymentRequest[] = [];
  const capability: ProviderCapability = {
    ...declaredCapability(name),
    supportedMethods: methods,
    payerCountries: ['SN'],
    supportedCurrencies: ['XOF'],
    priority,
    active: true,
  };
  const provider: PaymentProvider = {
    name,
    testMode: true,
    capability,
    createPayment: (request) => {
      calls.push(request);
      return Promise.resolve({
        providerPaymentId: `${name.toLowerCase()}_${request.paymentReference.slice(4)}`,
        redirectUrl: `https://checkout.example.test/${name.toLowerCase()}`,
      });
    },
    verifyWebhook: () => {
      throw new Error('not used');
    },
    parseWebhook: () => {
      throw new Error('not used');
    },
  };
  return { provider, calls, capability };
}

/**
 * PAY-HUB-1 through the API: payment options, immutable multi-currency
 * quotes, initiation from a quote, provider events checked against the
 * presentment amount, and routing that never changes the customer's method.
 */
describe('payment hub: options, quotes, initiation and routing (isolated database)', () => {
  let t: TestApp;
  let env: ApiEnv;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let alice: CustomerActor;
  let bob: CustomerActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    countryId = await syntheticCountry(t.app);
    [alice, bob] = await Promise.all([customerActor(t.app), customerActor(t.app)]);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  afterEach(() => vi.restoreAllMocks());

  const prisma = () => db(t.app);
  const fixture = (): Promise<BookableFixture> =>
    bookableFixture(t.app, { countryId, amount: () => UNIT });
  const hold = async (actor: CustomerActor, seats: string[] = ['1A', '1B']) => {
    const f = await fixture();
    const response = await bookingApi(actor).post('/bookings', holdBody(f, 1, 2, seats));
    expect(response.status).toBe(201);
    return response.body.reference as string;
  };
  const quote = (actor: CustomerActor, reference: string, payerCountry: string, method: string) =>
    paymentApi(actor).quote(reference, { payerCountry, paymentMethod: method });
  const pay = (
    actor: CustomerActor,
    reference: string,
    body: Record<string, unknown>,
    key?: string,
  ) => paymentApi(actor).create(reference, { body, ...(key ? { key } : {}) });
  const sandbox = () => t.app.get(PaymentCapabilityRegistry).provider('SANDBOX')!;
  const paymentsOf = (reference: string) =>
    prisma().payment.findMany({ where: { booking: { reference } }, orderBy: { id: 'asc' } });

  /** Every routing decision of the app goes through this synthetic registry. */
  const useRegistry = (providers: PaymentProvider[]) => {
    const synthetic = new PaymentCapabilityRegistry(providers);
    const registry = t.app.get(PaymentCapabilityRegistry);
    vi.spyOn(registry, 'hasActiveProvider').mockImplementation(() => synthetic.hasActiveProvider());
    vi.spyOn(registry, 'provider').mockImplementation((code) => synthetic.provider(code));
    vi.spyOn(registry, 'candidates').mockImplementation((input) => synthetic.candidates(input));
    vi.spyOn(registry, 'route').mockImplementation((input) => synthetic.route(input));
  };

  describe('payment options', () => {
    it('lists the methods of a payer country with their availability, and nothing internal', async () => {
      const reference = await hold(alice);
      const senegal = await paymentApi(alice).options(reference, 'SN');
      expect(senegal.status).toBe(200);
      expect(senegal.headers['cache-control']).toBe('no-store');
      expect(senegal.body).toMatchObject({ country: 'SN', currency: 'XOF', currencyMinorUnit: 0 });
      const methods = senegal.body.methods as Array<Record<string, unknown>>;
      expect(methods.map((method) => method.code)).toEqual(
        methodsForCountry('SN').map((method) => method.code),
      );
      for (const method of methods) {
        expect(Object.keys(method).sort()).toEqual(['available', 'code', 'group', 'label']);
      }
      // SANDBOX (CI) collects every method, and the synthetic rate converts EUR.
      expect(methods.every((method) => method.available === true)).toBe(true);
      expect(methods.find((method) => method.code === 'WAVE_SN')).toMatchObject({
        label: 'Wave',
        group: 'RECOMMENDED',
      });
      expect(JSON.stringify(senegal.body)).not.toMatch(
        /SANDBOX|priority|provider|PAYMENT_|secret|token|key/i,
      );
      const france = await paymentApi(alice).options(reference, 'fr');
      expect(france.body).toMatchObject({ country: 'FR', currency: 'EUR', currencyMinorUnit: 2 });

      const germany = await paymentApi(alice).options(reference, 'DE');
      expect(germany.status).toBe(422);
      expect(germany.body.code).toBe('PAYMENT_COUNTRY_UNSUPPORTED');
      expect((await paymentApi(alice).options(reference, 'SEN')).status).toBe(400);
      // Someone else's booking is unknown.
      const foreign = await paymentApi(bob).options(reference, 'SN');
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('BOOKING_NOT_FOUND');
    });

    it('describes methods as unavailable when nobody collects them or no rate exists', async () => {
      const reference = await hold(alice);
      useRegistry([]);
      const disabled = await paymentApi(alice).options(reference, 'FR');
      expect(disabled.status).toBe(200);
      expect(disabled.body.methods.length).toBeGreaterThan(0);
      expect(
        (disabled.body.methods as Array<{ available: boolean }>).every((m) => !m.available),
      ).toBe(true);
      vi.restoreAllMocks();
      // A deployed environment: no rate source, so XOF cannot be quoted.
      vi.spyOn(t.app.get(PaymentFxService), 'convert').mockReturnValue(null);
      const noRate = await paymentApi(alice).options(reference, 'SN');
      expect(
        (noRate.body.methods as Array<{ available: boolean }>).every((m) => !m.available),
      ).toBe(true);
      const refused = await quote(alice, reference, 'SN', 'WAVE_SN');
      expect(refused.status).toBe(503);
      expect(refused.body.code).toBe('PAYMENT_FX_UNAVAILABLE');
    });
  });

  describe('payment quotes', () => {
    it('quotes the exact booking total in the payer currency, as an immutable fact', async () => {
      const reference = await hold(alice);
      const response = await quote(alice, reference, 'SN', 'WAVE_SN');
      expect(response.status).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        id: expect.any(String),
        paymentMethod: 'WAVE_SN',
        payerCountry: 'SN',
        booking: { amountMinor: TOTAL, currencyCode: 'EUR', currencyMinorUnit: 2 },
        presentment: { amountMinor: XOF_TOTAL, currencyCode: 'XOF', currencyMinorUnit: 0 },
        fxRate: '655.957',
        fxSource: 'FX_SYNTHETIC_CI',
        quotedAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toMatch(/SANDBOX|candidate|provider/i);
      const row = await prisma().paymentQuote.findUniqueOrThrow({
        where: { id: response.body.id },
        include: { booking: true },
      });
      expect(row).toMatchObject({
        bookingAmountMinor: BigInt(TOTAL),
        presentmentAmountMinor: BigInt(XOF_TOTAL),
        providerCandidate: 'SANDBOX',
      });
      expect(row.expiresAt.getTime()).toBeGreaterThan(row.quotedAt.getTime());
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(row.booking.holdExpiresAt.getTime());
      const audit = await prisma().auditEvent.findFirstOrThrow({
        where: { action: 'PAYMENT_QUOTE_CREATED', resourceId: row.id },
      });
      expect(audit).toMatchObject({ actorIdentityId: alice.id, resourceType: 'payment_quote' });

      // A new price is a new quote: the row itself never changes.
      await expect(
        prisma().paymentQuote.update({
          where: { id: row.id },
          data: { presentmentAmountMinor: 1n },
        }),
      ).rejects.toThrow(/payment quotes are immutable/);
      await expect(prisma().paymentQuote.delete({ where: { id: row.id } })).rejects.toThrow(
        /payment quotes are immutable/,
      );
      const again = await quote(alice, reference, 'SN', 'WAVE_SN');
      expect(again.status).toBe(201);
      expect(again.body.id).not.toBe(response.body.id);
      expect(again.body.presentment).toEqual(response.body.presentment);
    });

    it('takes intentions only, offered methods only, for the owner only', async () => {
      const reference = await hold(alice);
      for (const body of [
        { payerCountry: 'SN', paymentMethod: 'WAVE_SN', amountMinor: 1 },
        { payerCountry: 'SN', paymentMethod: 'WAVE_SN', currencyCode: 'EUR' },
        { payerCountry: 'SN', paymentMethod: 'WAVE_SN', fxRate: '1' },
        { payerCountry: 'SN', paymentMethod: 'WAVE_SN', provider: 'WAVE' },
        { payerCountry: 'SN', paymentMethod: 'WAVE' },
      ]) {
        const response = await paymentApi(alice).quote(reference, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      const notOffered = await quote(alice, reference, 'SN', 'BIZUM');
      expect(notOffered.status).toBe(409);
      expect(notOffered.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      const country = await quote(alice, reference, 'DE', 'CARD_VISA');
      expect(country.status).toBe(422);
      expect(country.body.code).toBe('PAYMENT_COUNTRY_UNSUPPORTED');
      const foreign = await quote(bob, reference, 'SN', 'WAVE_SN');
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('BOOKING_NOT_FOUND');
      expect(await prisma().paymentQuote.count({ where: { booking: { reference } } })).toBe(0);
      const noCsrf = await paymentApi(alice).quote(
        reference,
        { payerCountry: 'SN', paymentMethod: 'WAVE_SN' },
        { csrf: null },
      );
      expect(noCsrf.status).toBe(403);
    });
  });

  describe('initiation from a quote', () => {
    it('keeps the booking amount, commits PENDING, then sends the presentment amount', async () => {
      const reference = await hold(alice);
      const quoted = await quote(alice, reference, 'SN', 'WAVE_SN');
      const provider = sandbox();
      const original = provider.createPayment.bind(provider);
      const seen: Array<{ status: string | undefined; openTransactions: number }> = [];
      let request: ProviderPaymentRequest | undefined;
      vi.spyOn(provider, 'createPayment').mockImplementation(async (input) => {
        request = input;
        // Another connection sees the committed PENDING row, and no
        // transaction of the API is open while the provider is called.
        const [row] = await prisma().payment.findMany({ where: { quoteId: quoted.body.id } });
        const [open] = await prisma().$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND state LIKE 'idle in transaction%'`;
        seen.push({ status: row?.status, openTransactions: Number(open!.count) });
        return original(input);
      });
      const response = await pay(alice, reference, {
        quoteId: quoted.body.id,
        paymentMethod: 'WAVE_SN',
      });
      expect(response.status).toBe(201);
      expect(seen).toEqual([{ status: 'PENDING', openTransactions: 0 }]);
      expect(request).toEqual({
        paymentReference: response.body.payment.reference,
        bookingReference: reference,
        paymentMethod: 'WAVE_SN',
        payerCountry: 'SN',
        presentmentAmountMinor: BigInt(XOF_TOTAL),
        presentmentCurrencyCode: 'XOF',
        presentmentCurrencyMinorUnit: 0,
      });
      expect(response.body.payment).toMatchObject({
        status: 'PENDING',
        amountMinor: TOTAL,
        currencyCode: 'EUR',
        paymentMethod: 'WAVE_SN',
        payerCountry: 'SN',
        presentment: { amountMinor: XOF_TOTAL, currencyCode: 'XOF', currencyMinorUnit: 0 },
      });
      const [stored] = await paymentsOf(reference);
      expect(stored).toMatchObject({
        amountMinor: BigInt(TOTAL),
        currencyCode: 'EUR',
        quoteId: quoted.body.id,
        provider: 'SANDBOX',
      });
      const audit = await prisma().auditEvent.findFirstOrThrow({
        where: { action: 'PAYMENT_CREATED', resourceId: stored!.id },
      });
      expect(audit.after).toMatchObject({
        amountMinor: TOTAL,
        currencyCode: 'EUR',
        quoteId: quoted.body.id,
        paymentMethod: 'WAVE_SN',
        payerCountry: 'SN',
      });
    });

    it('refuses a foreign, mismatched, expired or used quote, and any client amount', async () => {
      const reference = await hold(alice);
      const other = await hold(alice);
      const bobs = await hold(bob);
      const quoted = await quote(alice, reference, 'SN', 'WAVE_SN');
      const body = { quoteId: quoted.body.id, paymentMethod: 'WAVE_SN' };
      // Another booking (even of the same customer) or another customer: unknown.
      for (const [actor, target] of [
        [alice, other],
        [bob, bobs],
      ] as const) {
        const response = await pay(actor, target, body);
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('PAYMENT_QUOTE_NOT_FOUND');
      }
      const unknown = await pay(alice, reference, {
        quoteId: '01900000-0000-7000-8000-000000000000',
        paymentMethod: 'WAVE_SN',
      });
      expect(unknown.body.code).toBe('PAYMENT_QUOTE_NOT_FOUND');
      const mismatch = await pay(alice, reference, { ...body, paymentMethod: 'ORANGE_MONEY_SN' });
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.code).toBe('PAYMENT_QUOTE_MISMATCH');
      for (const extra of [{ amountMinor: 1 }, { currencyCode: 'XOF' }, { provider: 'WAVE' }]) {
        const response = await pay(alice, reference, { ...body, ...extra });
        expect(response.status, JSON.stringify(extra)).toBe(400);
      }
      expect(await paymentsOf(reference)).toHaveLength(0);

      // An expired quote of a still active hold starts nothing.
      const bookingId = (await prisma().booking.findUniqueOrThrow({ where: { reference: other } }))
        .id;
      const shortLived = await insertIdentityQuote(prisma(), bookingId, {
        expiresAt: new Date(Date.now() + 800),
      });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const expired = await pay(alice, other, {
        quoteId: shortLived.id,
        paymentMethod: shortLived.paymentMethod,
      });
      expect(expired.status).toBe(409);
      expect(expired.body.code).toBe('PAYMENT_QUOTE_EXPIRED');
      expect(await paymentsOf(other)).toHaveLength(0);

      // One attempt per quote: after a failure, a new quote is needed.
      const key = idempotencyKey();
      const first = await pay(alice, reference, body, key);
      expect(first.status).toBe(201);
      const replay = await pay(alice, reference, body, key);
      expect(replay.status).toBe(200);
      expect(replay.body.payment).toEqual(first.body.payment);
      const second = await quote(alice, reference, 'SN', 'WAVE_SN');
      const reused = await pay(
        alice,
        reference,
        { quoteId: second.body.id, paymentMethod: 'WAVE_SN' },
        key,
      );
      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe('PAYMENT_IDEMPOTENCY_KEY_REUSED');
      const failed = await settle(
        t.app,
        env,
        { reference: first.body.payment.reference, amountMinor: XOF_TOTAL, currencyCode: 'XOF' },
        'payment.failed',
        { failureReason: 'declined' },
      );
      expect(failed.status).toBe(200);
      const used = await pay(alice, reference, body);
      expect(used.status).toBe(409);
      expect(used.body.code).toBe('PAYMENT_QUOTE_ALREADY_USED');
      const retry = await pay(alice, reference, {
        quoteId: second.body.id,
        paymentMethod: 'WAVE_SN',
      });
      expect(retry.status).toBe(201);
    });
  });

  describe('provider events', () => {
    it('confirms only on the exact presentment amount and currency, and only once', async () => {
      const reference = await hold(alice);
      const quoted = await quote(alice, reference, 'SN', 'WAVE_SN');
      const created = await pay(alice, reference, {
        quoteId: quoted.body.id,
        paymentMethod: 'WAVE_SN',
      });
      const paymentReference = created.body.payment.reference as string;
      const [payment] = await paymentsOf(reference);
      const event = (amountMinor: number, currency: string, id?: string) =>
        sandboxEvent({
          type: 'payment.succeeded',
          providerPaymentId: payment!.providerPaymentId!,
          amountMinor,
          currency,
          ...(id ? { id } : {}),
        });

      // The booking amount in euros is not what the payer was asked for.
      const booking = await sendWebhook(t.app, env, event(TOTAL, 'EUR'));
      expect(booking.status).toBe(422);
      const wrongAmount = await sendWebhook(t.app, env, event(XOF_TOTAL - 1, 'XOF'));
      expect(wrongAmount.status).toBe(422);
      const wrongCurrency = await sendWebhook(t.app, env, event(XOF_TOTAL, 'EUR'));
      expect(wrongCurrency.status).toBe(422);
      const rejections = await prisma().paymentEvent.findMany({
        where: { paymentId: payment!.id },
        orderBy: { id: 'asc' },
        select: { rejectionCode: true, processedAt: true },
      });
      expect(rejections).toEqual([
        { rejectionCode: 'AMOUNT_MISMATCH', processedAt: null },
        { rejectionCode: 'AMOUNT_MISMATCH', processedAt: null },
        { rejectionCode: 'CURRENCY_MISMATCH', processedAt: null },
      ]);
      expect(
        (await prisma().booking.findUniqueOrThrow({ where: { reference } })).confirmedAt,
      ).toBeNull();

      const exact = event(XOF_TOTAL, 'XOF', 'evt_exact_presentment_01');
      const success = await sendWebhook(t.app, env, exact);
      expect(success.status).toBe(200);
      expect(success.body).toEqual({ received: true, outcome: 'PAYMENT_SUCCEEDED' });
      const confirmed = await prisma().booking.findUniqueOrThrow({ where: { reference } });
      expect(confirmed.confirmedAt).not.toBeNull();
      const succeeded = await prisma().payment.findUniqueOrThrow({
        where: { reference: paymentReference },
      });
      expect(succeeded).toMatchObject({
        status: 'SUCCEEDED',
        amountMinor: BigInt(TOTAL),
        currencyCode: 'EUR',
      });
      const audit = await prisma().auditEvent.findFirstOrThrow({
        where: { action: 'PAYMENT_SUCCEEDED', resourceId: payment!.id },
      });
      expect(audit.after).toMatchObject({
        amountMinor: TOTAL,
        currencyCode: 'EUR',
        collectedAmountMinor: XOF_TOTAL,
        collectedCurrencyCode: 'XOF',
      });

      // The same event again, or its id with another payload: one application only.
      expect((await sendWebhook(t.app, env, exact)).body.code).toBe('PAYMENT_WEBHOOK_REPLAY');
      const conflicting = await sendWebhook(
        t.app,
        env,
        event(XOF_TOTAL + 5, 'XOF', 'evt_exact_presentment_01'),
      );
      expect(conflicting.status).toBe(409);
      expect(conflicting.body.code).toBe('PAYMENT_WEBHOOK_REPLAY');
      const another = await sendWebhook(t.app, env, event(XOF_TOTAL, 'XOF'));
      expect(another.status).toBe(409);
      expect(another.body.code).toBe('PAYMENT_ALREADY_SUCCEEDED');
      const after = await prisma().booking.findUniqueOrThrow({ where: { reference } });
      expect(after.confirmedAt).toEqual(confirmed.confirmedAt);
      expect(
        await prisma().paymentEvent.count({
          where: { paymentId: payment!.id, processedAt: { not: null } },
        }),
      ).toBe(1);
    });

    it('never confirms from a provider redirect: only an authenticated event does', async () => {
      const reference = await hold(alice);
      const quoted = await quote(alice, reference, 'FR', 'CARD_CB');
      vi.spyOn(sandbox(), 'createPayment').mockResolvedValue({
        providerPaymentId: 'sbx_redirect_only_0001',
        redirectUrl: 'https://checkout.example.test/return?status=success',
      });
      const created = await pay(alice, reference, {
        quoteId: quoted.body.id,
        paymentMethod: 'CARD_CB',
      });
      expect(created.status).toBe(201);
      expect(created.body.checkout.redirectUrl).toBe(
        'https://checkout.example.test/return?status=success',
      );
      const booking = await bookingApi(alice).get(`/bookings/${reference}`);
      expect(booking.body.status).toBe('HELD');
      const [payment] = await paymentsOf(reference);
      expect(payment).toMatchObject({ status: 'PENDING', succeededAt: null });
    });
  });

  describe('routing', () => {
    it('falls back to another provider of the same method, never to another method', async () => {
      const wave = fakeProvider('WAVE', ['WAVE_SN'], 10);
      const aggregator = fakeProvider('PAYDUNYA', ['WAVE_SN'], 30);
      const cards = fakeProvider('STRIPE', ['CARD', 'CARD_VISA'], 1);
      useRegistry([wave.provider, aggregator.provider, cards.provider]);

      const reference = await hold(alice);
      const quoted = await quote(alice, reference, 'SN', 'WAVE_SN');
      expect(quoted.status).toBe(201);
      expect(
        (await prisma().paymentQuote.findUniqueOrThrow({ where: { id: quoted.body.id } }))
          .providerCandidate,
      ).toBe('WAVE');
      // Wave direct goes down after the quote: the aggregator collecting Wave takes over.
      wave.capability.active = false;
      const created = await pay(alice, reference, {
        quoteId: quoted.body.id,
        paymentMethod: 'WAVE_SN',
      });
      expect(created.status).toBe(201);
      expect(created.body.checkout).toMatchObject({ provider: 'PAYDUNYA' });
      const [payment] = await paymentsOf(reference);
      expect(payment).toMatchObject({ provider: 'PAYDUNYA', amountMinor: BigInt(TOTAL) });
      expect(wave.calls).toHaveLength(0);
      expect(cards.calls).toHaveLength(0);
      expect(aggregator.calls).toEqual([
        expect.objectContaining({
          paymentMethod: 'WAVE_SN',
          presentmentAmountMinor: BigInt(XOF_TOTAL),
          presentmentCurrencyCode: 'XOF',
        }),
      ]);
      // That provider's authenticated event confirms, on the presentment amount.
      const outcome = await t.app.get(PaymentWebhookService).process('PAYDUNYA', {
        providerEventId: 'evt_paydunya_wave_0001',
        type: 'PAYMENT_SUCCEEDED',
        providerPaymentId: payment!.providerPaymentId!,
        amountMinor: BigInt(XOF_TOTAL),
        currencyCode: 'XOF',
        failureCode: null,
        payloadHash: 'b'.repeat(64),
      });
      expect(outcome).toEqual({ outcome: 'PAYMENT_SUCCEEDED' });

      // Nobody collects Wave any more: unavailable, never charged to a card.
      const next = await hold(alice);
      const quotedNext = await quote(alice, next, 'SN', 'WAVE_SN');
      expect(quotedNext.status).toBe(201);
      aggregator.capability.active = false;
      const refused = await pay(alice, next, {
        quoteId: quotedNext.body.id,
        paymentMethod: 'WAVE_SN',
      });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      expect(await paymentsOf(next)).toHaveLength(0);
      expect(cards.calls).toHaveLength(0);
      const noQuote = await quote(alice, next, 'SN', 'WAVE_SN');
      expect(noQuote.status).toBe(409);
      expect(noQuote.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      const cardQuote = await quote(alice, next, 'SN', 'CARD');
      expect(cardQuote.status).toBe(201);
    });

    it('takes no payment at all while no provider is configured', async () => {
      const reference = await hold(alice);
      const quoted = await quote(alice, reference, 'FR', 'CARD_CB');
      useRegistry([]);
      const noQuote = await quote(alice, reference, 'FR', 'CARD_CB');
      expect(noQuote.status).toBe(503);
      expect(noQuote.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      const noPayment = await pay(alice, reference, {
        quoteId: quoted.body.id,
        paymentMethod: 'CARD_CB',
      });
      expect(noPayment.status).toBe(503);
      expect(noPayment.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      expect(await paymentsOf(reference)).toHaveLength(0);
    });
  });
});
