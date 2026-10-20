import type { ApiEnv } from '@euroteranga/config';
import {
  PaymentFxSource,
  PaymentMethod,
  PaymentProvider,
  type Prisma,
} from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { insertIdentityQuote, paymentApi, settle } from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * PAY-HUB-1 invariants enforced by PostgreSQL for every writer (direct
 * Prisma writes, no API in front): immutable quotes covering the exact
 * booking total, new attempts only from a quote, settlements as later facts.
 */
describe('payment hub database invariants (isolated database)', () => {
  let t: TestApp;
  let env: ApiEnv;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let alice: CustomerActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    env = integrationEnv({ DATABASE_URL: database.url });
    t = await startTestApp(env);
    countryId = await syntheticCountry(t.app);
    alice = await customerActor(t.app);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const prisma = () => db(t.app);

  /** A HELD booking of alice: 2 seats x 124.50 EUR. */
  const heldBooking = async () => {
    const f = await bookableFixture(t.app, { countryId, amount: () => 12_450 });
    const response = await bookingApi(alice).post('/bookings', holdBody(f, 1, 2, ['1A', '1B']));
    expect(response.status).toBe(201);
    return prisma().booking.findUniqueOrThrow({
      where: { reference: response.body.reference as string },
    });
  };

  /** A valid EUR -> XOF quote of a booking, with optional overrides. */
  const quoteData = (
    booking: { id: string; holdExpiresAt: Date },
    overrides: Partial<Prisma.PaymentQuoteUncheckedCreateInput> = {},
  ): Prisma.PaymentQuoteUncheckedCreateInput => ({
    bookingId: booking.id,
    bookingAmountMinor: 24_900n,
    bookingCurrencyCode: 'EUR',
    bookingCurrencyMinorUnit: 2,
    presentmentAmountMinor: 163_333n,
    presentmentCurrencyCode: 'XOF',
    presentmentCurrencyMinorUnit: 0,
    fxRate: '655.957',
    fxSource: 'FX_SYNTHETIC_CI',
    quotedAt: new Date(),
    expiresAt: new Date(Math.min(Date.now() + 600_000, booking.holdExpiresAt.getTime())),
    payerCountry: 'SN',
    paymentMethod: 'WAVE_SN',
    providerCandidate: 'SANDBOX',
    ...overrides,
  });
  const insertQuote = (data: Prisma.PaymentQuoteUncheckedCreateInput) =>
    prisma().paymentQuote.create({ data });

  it('keeps Prisma and PostgreSQL enums identical', async () => {
    const labels = async (type: string) =>
      (
        await prisma().$queryRaw<Array<{ label: string }>>`
          SELECT e.enumlabel AS "label" FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = ${type} ORDER BY e.enumsortorder`
      ).map((row) => row.label);
    expect(await labels('payment_provider')).toEqual(Object.values(PaymentProvider));
    expect(await labels('payment_method')).toEqual(Object.values(PaymentMethod));
    expect(await labels('payment_fx_source')).toEqual(Object.values(PaymentFxSource));
  });

  it('accepts a quote only as the exact booking total at its own rate, for an active hold', async () => {
    const booking = await heldBooking();
    const valid = await insertQuote(quoteData(booking));
    expect(valid.presentmentAmountMinor).toBe(163_333n);
    for (const [label, overrides, error] of [
      [
        'booking total',
        { bookingAmountMinor: 12_450n, presentmentAmountMinor: 81_667n },
        /exact booking total/,
      ],
      [
        'booking currency',
        { bookingCurrencyCode: 'XOF' },
        /payment_quote_fx_identity|exact booking total/,
      ],
      [
        'outlasting the hold',
        { expiresAt: new Date(booking.holdExpiresAt.getTime() + 1_000) },
        /cannot outlast its booking hold/,
      ],
      [
        'amount not from the rate',
        { presentmentAmountMinor: 163_334n },
        /payment_quote_presentment_from_rate/,
      ],
      ['identity across currencies', { fxSource: 'FX_IDENTITY' }, /payment_quote_fx_identity/],
      [
        'XOF with decimals',
        { presentmentCurrencyMinorUnit: 2, presentmentAmountMinor: 16_333_329n },
        /payment_quote_presentment_currency/,
      ],
      [
        'unsupported currency',
        { presentmentCurrencyCode: 'USD', presentmentCurrencyMinorUnit: 2 },
        /payment_quote_presentment_currency/,
      ],
      ['payer country', { payerCountry: 'DE' }, /payment_quote_payer_country/],
      [
        'non-positive rate',
        { fxRate: '0', presentmentAmountMinor: 1n },
        /payment_quote_fx_rate_positive|payment_quote_presentment_from_rate/,
      ],
      ['empty window', { expiresAt: new Date(Date.now() - 1_000) }, /payment_quote_window/],
    ] as const) {
      await expect(insertQuote(quoteData(booking, overrides)), label).rejects.toThrow(error);
    }
    // Same currency: the identity, exactly.
    await expect(
      insertQuote(
        quoteData(booking, {
          presentmentAmountMinor: 24_900n,
          presentmentCurrencyCode: 'EUR',
          presentmentCurrencyMinorUnit: 2,
          fxRate: '1.5',
          fxSource: 'FX_IDENTITY',
          payerCountry: 'FR',
          paymentMethod: 'CARD_CB',
        }),
      ),
    ).rejects.toThrow(/payment_quote_fx_identity|payment_quote_presentment_from_rate/);
    const identity = await insertIdentityQuote(prisma(), booking.id);
    expect(identity.paymentMethod).toBe('CARD_CB');

    // Immutable and never deleted or truncated.
    await expect(
      prisma().paymentQuote.update({ where: { id: valid.id }, data: { fxRate: '600' } }),
    ).rejects.toThrow(/payment quotes are immutable/);
    await expect(prisma().paymentQuote.delete({ where: { id: valid.id } })).rejects.toThrow(
      /payment quotes are immutable/,
    );
    await expect(prisma().$executeRawUnsafe('TRUNCATE "payment_quote" CASCADE')).rejects.toThrow(
      /cannot be truncated/,
    );

    // A cancelled hold receives no quote.
    const cancelled = await heldBooking();
    expect((await bookingApi(alice).post(`/bookings/${cancelled.reference}/cancel`)).status).toBe(
      200,
    );
    await expect(insertQuote(quoteData(cancelled))).rejects.toThrow(/active booking hold/);
  });

  it('starts new attempts only from an unexpired quote of the same booking', async () => {
    const booking = await heldBooking();
    const other = await heldBooking();
    const otherQuote = await insertQuote(quoteData(other));
    const attempt = (overrides: Partial<Prisma.PaymentUncheckedCreateInput>) =>
      prisma().payment.create({
        data: {
          reference: `ETP-${'0123456789ABCDEFGHJKMNPQRSTVWXYZ'
            .split('')
            .sort(() => Math.random() - 0.5)
            .slice(0, 12)
            .join('')}`,
          bookingId: booking.id,
          customerIdentityId: booking.customerIdentityId,
          provider: 'SANDBOX',
          amountMinor: 24_900n,
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
          ...overrides,
        },
      });
    await expect(attempt({})).rejects.toThrow(/needs a payment quote/);
    await expect(attempt({ quoteId: otherQuote.id })).rejects.toThrow(/same booking amount/);
    const shortLived = await insertQuote(
      quoteData(booking, { expiresAt: new Date(Date.now() + 700) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await expect(attempt({ quoteId: shortLived.id })).rejects.toThrow(/expired payment quote/);
    const fresh = await insertQuote(quoteData(booking));
    const payment = await attempt({ quoteId: fresh.id });
    expect(payment.quoteId).toBe(fresh.id);
    // One attempt per quote.
    await prisma().payment.update({
      where: { id: payment.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await expect(attempt({ quoteId: fresh.id })).rejects.toThrow(/Unique constraint|quote_id/);
  });

  it('records a settlement only for a SUCCEEDED payment, immutably, without changing it', async () => {
    const booking = await heldBooking();
    const quoted = await paymentApi(alice).quote(booking.reference, {
      payerCountry: 'SN',
      paymentMethod: 'WAVE_SN',
    });
    const created = await paymentApi(alice).create(booking.reference, {
      body: { quoteId: quoted.body.id, paymentMethod: 'WAVE_SN' },
    });
    expect(created.status).toBe(201);
    const pending = await prisma().payment.findUniqueOrThrow({
      where: { reference: created.body.payment.reference },
    });
    const settlement = (
      overrides: Partial<Prisma.PaymentSettlementUncheckedCreateInput> = {},
    ): Prisma.PaymentSettlementUncheckedCreateInput => ({
      paymentId: pending.id,
      provider: 'SANDBOX',
      providerTransactionId: pending.providerPaymentId!,
      settlementReference: 'STL-2030-0001',
      grossAmountMinor: 163_333n,
      providerFeeMinor: 1_633n,
      netAmountMinor: 161_700n,
      settlementCurrencyCode: 'XOF',
      settlementCurrencyMinorUnit: 0,
      settledAt: new Date(),
      ...overrides,
    });
    const insert = (data: Prisma.PaymentSettlementUncheckedCreateInput) =>
      prisma().paymentSettlement.create({ data });
    await expect(insert(settlement())).rejects.toThrow(/only a SUCCEEDED payment can be settled/);

    const success = await settle(t.app, env, {
      reference: pending.reference,
      amountMinor: 163_333,
      currencyCode: 'XOF',
    });
    expect(success.status).toBe(200);
    const succeeded = await prisma().payment.findUniqueOrThrow({ where: { id: pending.id } });
    for (const [label, overrides, error] of [
      ['transaction', { providerTransactionId: 'sbx_another_transaction' }, /provider transaction/],
      ['net amount', { netAmountMinor: 161_701n }, /payment_settlement_amounts/],
      [
        'negative fee',
        { providerFeeMinor: -1n, netAmountMinor: 163_334n },
        /payment_settlement_amounts/,
      ],
      ['future date', { settledAt: new Date(Date.now() + 3_600_000) }, /in the future/],
      [
        'reference format',
        { settlementReference: 'bad reference' },
        /payment_settlement_reference_format/,
      ],
    ] as const) {
      await expect(insert(settlement(overrides)), label).rejects.toThrow(error);
    }
    // Settled later, possibly in another currency: a fact of its own.
    const recorded = await insert(
      settlement({
        settledAt: new Date(Date.now() - 86_400_000),
        grossAmountMinor: 24_900n,
        providerFeeMinor: 249n,
        netAmountMinor: 24_651n,
        settlementCurrencyCode: 'EUR',
        settlementCurrencyMinorUnit: 2,
      }),
    );
    expect(recorded.recordedAt.getTime()).toBeGreaterThan(recorded.settledAt.getTime());
    expect(await prisma().payment.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(
      succeeded,
    );
    await expect(insert(settlement({ settlementReference: 'STL-2030-0002' }))).rejects.toThrow(
      /Unique constraint|payment_id/,
    );
    await expect(
      prisma().paymentSettlement.update({
        where: { id: recorded.id },
        data: { providerFeeMinor: 0n, netAmountMinor: 24_900n },
      }),
    ).rejects.toThrow(/payment settlements are immutable/);
    await expect(prisma().paymentSettlement.delete({ where: { id: recorded.id } })).rejects.toThrow(
      /payment settlements are immutable/,
    );
  });
});
