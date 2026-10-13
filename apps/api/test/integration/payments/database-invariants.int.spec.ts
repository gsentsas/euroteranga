import { randomBytes } from 'node:crypto';
import type { Prisma } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isolatedDatabase } from '../../support/admin-helpers.js';
import { db } from '../../support/auth-helpers.js';
import {
  bookableFixture,
  bookingApi,
  customerActor,
  expiredHold,
  holdBody,
  syntheticCountry,
  type BookableFixture,
  type CustomerActor,
} from '../../support/booking-helpers.js';
import { shortHold, waitUntilExpired } from '../../support/payment-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const paymentReference = () =>
  `ETP-${Array.from(randomBytes(12), (byte) => ALPHABET[byte % 32]).join('')}`;
const eventId = () => `evt_${randomBytes(10).toString('hex')}`;
const hash = () => randomBytes(32).toString('hex');

/**
 * PR-10 invariants enforced by PostgreSQL for every writer, exercised with
 * direct Prisma and SQL writes (no API validation in front). Own database:
 * TRUNCATE attempts take exclusive locks.
 */
describe('payment database invariants (isolated database)', () => {
  let t: TestApp;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let countryId: string;
  let alice: CustomerActor;
  let bob: CustomerActor;

  beforeAll(async () => {
    database = await isolatedDatabase();
    t = await startTestApp(integrationEnv({ DATABASE_URL: database.url }));
    countryId = await syntheticCountry(t.app);
    [alice, bob] = await Promise.all([customerActor(t.app), customerActor(t.app)]);
  });

  afterAll(async () => {
    await t.app.close();
    await database.drop();
  });

  const prisma = () => db(t.app);
  const fixture = (options = {}) => bookableFixture(t.app, { countryId, ...options });

  /** A HELD booking of alice (API path), with its exact total. */
  async function heldBooking(
    f: BookableFixture,
    origin: number,
    destination: number,
    seats: string[],
  ) {
    const response = await bookingApi(alice).post(
      '/bookings',
      holdBody(f, origin, destination, seats),
    );
    expect(response.status).toBe(201);
    const booking = await prisma().booking.findUniqueOrThrow({
      where: { reference: response.body.reference as string },
    });
    return { ...booking, total: BigInt(booking.unitAmountMinor) * BigInt(seats.length) };
  }

  const paymentData = (
    booking: {
      id: string;
      customerIdentityId: string;
      currencyCode: string;
      currencyMinorUnit: number;
      total: bigint;
    },
    overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {},
  ): Prisma.PaymentUncheckedCreateInput => ({
    reference: paymentReference(),
    bookingId: booking.id,
    customerIdentityId: booking.customerIdentityId,
    provider: 'SANDBOX',
    providerPaymentId: `sbx_${randomBytes(9).toString('hex')}`,
    amountMinor: booking.total,
    currencyCode: booking.currencyCode,
    currencyMinorUnit: booking.currencyMinorUnit,
    ...overrides,
  });

  const insert = (data: Prisma.PaymentUncheckedCreateInput) => prisma().payment.create({ data });

  /** The webhook's writes, done directly: processed event, success, confirmation. */
  const succeed = (paymentId: string, bookingId: string) =>
    prisma().$transaction(async (tx) => {
      const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
      await tx.paymentEvent.create({
        data: {
          paymentId,
          provider: 'SANDBOX',
          providerEventId: eventId(),
          type: 'PAYMENT_SUCCEEDED',
          payloadHash: hash(),
          receivedAt: now,
          processedAt: now,
        },
      });
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'SUCCEEDED', succeededAt: now },
      });
      await tx.booking.update({ where: { id: bookingId }, data: { confirmedAt: now } });
    });

  async function confirmedBooking(
    f: BookableFixture,
    origin: number,
    destination: number,
    seats: string[],
  ) {
    const booking = await heldBooking(f, origin, destination, seats);
    const payment = await insert(paymentData(booking));
    await succeed(payment.id, booking.id);
    return { booking, payment };
  }

  describe('payment creation', () => {
    it('accepts only the exact PENDING total of an active hold, paid by its owner', async () => {
      const f = await fixture({ amount: () => 12_345 });
      const booking = await heldBooking(f, 1, 3, ['1A', '1B']);
      expect(booking.total).toBe(24_690n);
      for (const [label, overrides] of [
        ['amount + 1', { amountMinor: booking.total + 1n }],
        ['unit amount only', { amountMinor: 12_345n }],
        ['currency', { currencyCode: 'XOF' }],
        ['minor unit', { currencyMinorUnit: 0 }],
      ] as const) {
        await expect(insert(paymentData(booking, overrides)), label).rejects.toThrow(
          /exact total of its booking/,
        );
      }
      await expect(insert(paymentData(booking, { customerIdentityId: bob.id }))).rejects.toThrow(
        /owner of its booking/,
      );
      for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
        await expect(insert(paymentData(booking, { status })), status).rejects.toThrow(
          /created PENDING/,
        );
      }
      const valid = await insert(paymentData(booking));
      expect(valid).toMatchObject({ status: 'PENDING', amountMinor: 24_690n });
    });

    it('refuses attempts for cancelled, expired and confirmed bookings', async () => {
      const f = await fixture();
      const cancelled = await heldBooking(f, 1, 2, ['1A']);
      expect((await bookingApi(alice).post(`/bookings/${cancelled.reference}/cancel`)).status).toBe(
        200,
      );
      await expect(insert(paymentData(cancelled))).rejects.toThrow(
        /only an active hold can be paid/,
      );
      const expired = await expiredHold(t.app, f, alice.id, 2, 3, ['1A']);
      const expiredRow = await prisma().booking.findUniqueOrThrow({ where: { id: expired.id } });
      await expect(
        insert(paymentData({ ...expiredRow, total: BigInt(expiredRow.unitAmountMinor) })),
      ).rejects.toThrow(/only an active hold can be paid/);
      const { booking } = await confirmedBooking(f, 3, 4, ['1A']);
      await expect(insert(paymentData(booking))).rejects.toThrow(/only an active hold can be paid/);
    });

    it('enforces formats and status consistency (CHECK constraints)', async () => {
      const f = await fixture();
      const booking = await heldBooking(f, 1, 2, ['2A']);
      for (const [reference, label] of [
        ['ETB-ABCDEFGHJKMN', 'booking prefix'],
        ['ETP-abcdefghjkmn', 'lowercase'],
        ['ETP-0000000000IL', 'ambiguous letters'],
      ] as const) {
        await expect(insert(paymentData(booking, { reference })), label).rejects.toThrow(
          /payment_reference_format/,
        );
      }
      await expect(insert(paymentData(booking, { idempotencyKey: 'short' }))).rejects.toThrow(
        /payment_idempotency_key_format/,
      );
      await expect(
        insert(paymentData(booking, { providerPaymentId: 'bad id with spaces' })),
      ).rejects.toThrow(/payment_provider_payment_id_format/);
      await expect(insert(paymentData(booking, { failureCode: 'DECLINED' }))).rejects.toThrow(
        /payment_status_consistent/,
      );
      await expect(insert(paymentData(booking, { succeededAt: new Date() }))).rejects.toThrow(
        /payment_status_consistent/,
      );
      const checks = await prisma().$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE conrelid IN ('payment'::regclass, 'payment_event'::regclass) AND contype = 'c'
        ORDER BY conname`;
      expect(checks.map((check) => check.conname)).toEqual([
        'payment_amount_positive',
        'payment_currency_code_format',
        'payment_currency_minor_unit_range',
        'payment_event_outcome_consistent',
        'payment_event_payload_hash_format',
        'payment_event_provider_event_id_format',
        'payment_failure_code_known',
        'payment_idempotency_key_format',
        'payment_provider_payment_id_format',
        'payment_reference_format',
        'payment_status_consistent',
        'payment_transition_after_creation',
      ]);
      const indexes = await prisma().$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('payment', 'payment_event') AND indexdef LIKE '%WHERE%'
        ORDER BY indexname`;
      expect(
        indexes.map((index) => [index.indexname, index.indexdef.replace(/^.* WHERE /, '')]),
      ).toEqual([
        ['payment_event_one_processed_per_payment', '(processed_at IS NOT NULL)'],
        ['payment_one_pending_per_booking', "(status = 'PENDING'::payment_status)"],
        ['payment_one_succeeded_per_booking', "(status = 'SUCCEEDED'::payment_status)"],
      ]);
    });

    it('allows a single PENDING and a single SUCCEEDED attempt per booking', async () => {
      const f = await fixture();
      const booking = await heldBooking(f, 1, 3, ['2B']);
      const first = await insert(paymentData(booking));
      await expect(insert(paymentData(booking))).rejects.toThrow(
        /payment_one_pending_per_booking|Unique constraint/,
      );
      await prisma().$transaction(async (tx) => {
        const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
        await tx.paymentEvent.create({
          data: {
            paymentId: first.id,
            provider: 'SANDBOX',
            providerEventId: eventId(),
            type: 'PAYMENT_FAILED',
            payloadHash: hash(),
            receivedAt: now,
            processedAt: now,
          },
        });
        await tx.payment.update({
          where: { id: first.id },
          data: { status: 'FAILED', failedAt: now, failureCode: 'DECLINED' },
        });
      });
      const second = await insert(paymentData(booking));
      await succeed(second.id, booking.id);
      // A second success cannot exist: the booking is no longer an active hold,
      // and the failed attempt is final.
      await expect(insert(paymentData(booking))).rejects.toThrow(/only an active hold can be paid/);
      await expect(
        prisma().payment.update({
          where: { id: first.id },
          data: { status: 'SUCCEEDED', succeededAt: new Date(), failedAt: null, failureCode: null },
        }),
      ).rejects.toThrow(/FAILED payment is final/);
      expect(
        await prisma().payment.count({ where: { bookingId: booking.id, status: 'SUCCEEDED' } }),
      ).toBe(1);
    });
  });

  describe('payment lifecycle', () => {
    it('refuses SUCCEEDED or FAILED without a processed provider event', async () => {
      const f = await fixture();
      const booking = await heldBooking(f, 1, 2, ['1B']);
      const payment = await insert(paymentData(booking));
      await expect(
        prisma().payment.update({
          where: { id: payment.id },
          data: { status: 'SUCCEEDED', succeededAt: new Date() },
        }),
      ).rejects.toThrow(/only through a processed provider success event/);
      await expect(
        prisma().payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', failedAt: new Date(), failureCode: 'DECLINED' },
        }),
      ).rejects.toThrow(/only through a processed provider event/);
      // A recorded but rejected event is not a processing.
      const [{ now }] = await prisma().$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
      await prisma().paymentEvent.create({
        data: {
          paymentId: payment.id,
          provider: 'SANDBOX',
          providerEventId: eventId(),
          type: 'PAYMENT_SUCCEEDED',
          payloadHash: hash(),
          receivedAt: now,
          rejectionCode: 'AMOUNT_MISMATCH',
        },
      });
      await expect(
        prisma().payment.update({
          where: { id: payment.id },
          data: { status: 'SUCCEEDED', succeededAt: new Date() },
        }),
      ).rejects.toThrow(/only through a processed provider success event/);
      // CANCELLED needs no event (a local decision).
      await prisma().payment.update({
        where: { id: payment.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
    });

    it('requires the booking confirmation in the same transaction as a success', async () => {
      const f = await fixture();
      const booking = await heldBooking(f, 2, 3, ['1B']);
      const payment = await insert(paymentData(booking));
      await expect(
        prisma().$transaction(async (tx) => {
          const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
          await tx.paymentEvent.create({
            data: {
              paymentId: payment.id,
              provider: 'SANDBOX',
              providerEventId: eventId(),
              type: 'PAYMENT_SUCCEEDED',
              payloadHash: hash(),
              receivedAt: now,
              processedAt: now,
            },
          });
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'SUCCEEDED', succeededAt: now },
          });
        }),
      ).rejects.toThrow(/must confirm its booking in the same transaction/);
      const stored = await prisma().payment.findUniqueOrThrow({
        where: { id: payment.id },
        include: { events: true },
      });
      expect(stored.status).toBe('PENDING');
      expect(stored.events).toHaveLength(0);
      await succeed(payment.id, booking.id);
      expect(
        (await prisma().booking.findUniqueOrThrow({ where: { id: booking.id } })).confirmedAt,
      ).not.toBeNull();
    });

    it('keeps terminal attempts final and identities immutable', async () => {
      const f = await fixture();
      const { booking, payment } = await confirmedBooking(f, 1, 2, ['2A']);
      for (const [label, data] of [
        [
          'to FAILED',
          { status: 'FAILED', failedAt: new Date(), failureCode: 'DECLINED', succeededAt: null },
        ],
        ['to CANCELLED', { status: 'CANCELLED', cancelledAt: new Date(), succeededAt: null }],
        ['to PENDING', { status: 'PENDING', succeededAt: null }],
        ['provider id', { providerPaymentId: 'sbx_otherotherother' }],
      ] as const) {
        await expect(
          prisma().payment.update({ where: { id: payment.id }, data }),
          label,
        ).rejects.toThrow(/SUCCEEDED payment is final/);
      }
      const other = await heldBooking(f, 2, 3, ['2A']);
      const pending = await insert(paymentData(other, { providerPaymentId: null }));
      for (const [label, data] of [
        ['amount', { amountMinor: other.total + 1n }],
        ['booking', { bookingId: booking.id }],
        ['reference', { reference: paymentReference() }],
        ['customer', { customerIdentityId: bob.id }],
        ['idempotency key', { idempotencyKey: 'a-new-idempotency-key' }],
      ] as const) {
        await expect(
          prisma().payment.update({ where: { id: pending.id }, data }),
          label,
        ).rejects.toThrow(/identity, booking and amount are immutable/);
      }
      // The provider id can be learnt once, then never changes.
      await prisma().payment.update({
        where: { id: pending.id },
        data: { providerPaymentId: 'sbx_learntlater01' },
      });
      await expect(
        prisma().payment.update({
          where: { id: pending.id },
          data: { providerPaymentId: 'sbx_changedlater1' },
        }),
      ).rejects.toThrow(/provider payment id is immutable/);
      // Cancelled is final too.
      await prisma().payment.update({
        where: { id: pending.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await expect(
        prisma().payment.update({
          where: { id: pending.id },
          data: { cancelledAt: new Date(Date.now() + 1000) },
        }),
      ).rejects.toThrow(/CANCELLED payment is final/);
    });

    it('never deletes or truncates payments', async () => {
      const f = await fixture();
      const booking = await heldBooking(f, 3, 5, ['2A']);
      const payment = await insert(paymentData(booking));
      await expect(prisma().payment.delete({ where: { id: payment.id } })).rejects.toThrow(
        /payments cannot be deleted/,
      );
      // Each table refuses on its own (CASCADE would otherwise reach the other).
      await expect(prisma().$executeRawUnsafe('TRUNCATE "payment" CASCADE')).rejects.toThrow(
        /payment history cannot be truncated \(payment\)/,
      );
      await expect(prisma().$executeRawUnsafe('TRUNCATE "payment_event"')).rejects.toThrow(
        /payment history cannot be truncated \(payment_event\)/,
      );
      expect(await prisma().payment.count({ where: { id: payment.id } })).toBe(1);
    });
  });

  describe('payment events', () => {
    it('records each provider event once, immutably, without payload', async () => {
      const f = await fixture();
      const booking = await heldBooking(f, 1, 4, ['1A']);
      const payment = await insert(paymentData(booking));
      const [{ now }] = await prisma().$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
      const event = (overrides: Partial<Prisma.PaymentEventUncheckedCreateInput> = {}) =>
        prisma().paymentEvent.create({
          data: {
            paymentId: payment.id,
            provider: 'SANDBOX',
            providerEventId: eventId(),
            type: 'PAYMENT_SUCCEEDED',
            payloadHash: hash(),
            receivedAt: now,
            rejectionCode: 'CURRENCY_MISMATCH',
            ...overrides,
          },
        });
      const recorded = await event({ providerEventId: 'evt_unique_once_1' });
      await expect(event({ providerEventId: 'evt_unique_once_1' })).rejects.toThrow(
        /Unique constraint|provider_event_id/,
      );
      await expect(
        prisma().paymentEvent.update({
          where: { id: recorded.id },
          data: { rejectionCode: 'AMOUNT_MISMATCH' },
        }),
      ).rejects.toThrow(/payment events are immutable/);
      await expect(prisma().paymentEvent.delete({ where: { id: recorded.id } })).rejects.toThrow(
        /payment events are immutable/,
      );
      for (const [label, overrides, pattern] of [
        [
          'neither processed nor rejected',
          { rejectionCode: null },
          /payment_event_outcome_consistent/,
        ],
        ['both', { processedAt: now }, /payment_event_outcome_consistent/],
        ['unknown rejection', { rejectionCode: 'WHATEVER' }, /payment_event_outcome_consistent/],
        ['payload hash', { payloadHash: 'Z'.repeat(64) }, /payment_event_payload_hash_format/],
        ['event id', { providerEventId: 'bad id' }, /payment_event_provider_event_id_format/],
      ] as const) {
        await expect(event(overrides), label).rejects.toThrow(pattern);
      }
      // One processed event per payment, and only while it is PENDING.
      await expect(
        prisma().$transaction(async (tx) => {
          for (let index = 0; index < 2; index += 1) {
            await tx.paymentEvent.create({
              data: {
                paymentId: payment.id,
                provider: 'SANDBOX',
                providerEventId: eventId(),
                type: 'PAYMENT_FAILED',
                payloadHash: hash(),
                receivedAt: now,
                processedAt: now,
              },
            });
          }
        }),
      ).rejects.toThrow(/payment_event_one_processed_per_payment|Unique constraint/);
      await succeed(payment.id, booking.id);
      await expect(event({ rejectionCode: null, processedAt: now })).rejects.toThrow(
        /only an event of a PENDING payment can be processed/,
      );
      const columns = await prisma().$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'payment_event' ORDER BY 1`;
      expect(columns.map((column) => column.column_name)).not.toContain('payload');
    });
  });

  describe('booking confirmation', () => {
    it('is set once, by a succeeded payment, on an active hold', async () => {
      const f = await fixture();
      const held = await heldBooking(f, 1, 2, ['1B']);
      await expect(
        prisma().booking.update({ where: { id: held.id }, data: { confirmedAt: new Date() } }),
      ).rejects.toThrow(/confirmed only by a succeeded payment/);
      await expect(
        prisma().booking.create({
          data: {
            reference: `ETB-${Array.from(randomBytes(12), (byte) => ALPHABET[byte % 32]).join('')}`,
            customerIdentityId: alice.id,
            tripId: f.tripId,
            originRouteWaypointId: f.wp[3]!,
            destinationRouteWaypointId: f.wp[4]!,
            originSequence: 3,
            destinationSequence: 4,
            fareEntryId: held.fareEntryId,
            unitAmountMinor: held.unitAmountMinor,
            currencyCode: held.currencyCode,
            currencyMinorUnit: held.currencyMinorUnit,
            holdExpiresAt: new Date(Date.now() + 60_000),
            confirmedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/created as active holds/);

      const expired = await expiredHold(t.app, f, alice.id, 2, 3, ['1B']);
      await expect(
        prisma().booking.update({ where: { id: expired.id }, data: { confirmedAt: new Date() } }),
      ).rejects.toThrow(/an expired hold cannot be confirmed/);

      const { booking } = await confirmedBooking(f, 3, 5, ['1B']);
      await expect(
        prisma().booking.update({
          where: { id: booking.id },
          data: { confirmedAt: new Date(Date.now() + 1000) },
        }),
      ).rejects.toThrow(/confirmation of a booking is immutable/);
      await expect(
        prisma().booking.update({ where: { id: booking.id }, data: { confirmedAt: null } }),
      ).rejects.toThrow(/confirmation of a booking is immutable/);
      await expect(
        prisma().booking.update({
          where: { id: booking.id },
          data: { cancelledAt: new Date(), cancellationReason: 'Essai direct' },
        }),
      ).rejects.toThrow(/confirmed booking cannot be cancelled/);
    });

    it('keeps the confirmation within the hold (CHECK) and never with a cancellation', async () => {
      const f = await fixture();
      const held = await heldBooking(f, 1, 3, ['2B']);
      const payment = await insert(paymentData(held));
      await expect(
        prisma().$transaction(async (tx) => {
          const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS "now"`;
          await tx.paymentEvent.create({
            data: {
              paymentId: payment.id,
              provider: 'SANDBOX',
              providerEventId: eventId(),
              type: 'PAYMENT_SUCCEEDED',
              payloadHash: hash(),
              receivedAt: now,
              processedAt: now,
            },
          });
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'SUCCEEDED', succeededAt: now },
          });
          await tx.booking.update({
            where: { id: held.id },
            data: { confirmedAt: new Date(held.createdAt.getTime() - 1000) },
          });
        }),
      ).rejects.toThrow(/booking_confirmation_consistent/);
      expect((await prisma().payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
        'PENDING',
      );
    });
  });

  describe('confirmed inventory', () => {
    it('never releases, extends or deletes the inventory of a confirmed booking', async () => {
      const f = await fixture();
      const short = await shortHold(t.app, f, alice.id, 1, 3, ['2A'], 3_000);
      const row = await prisma().booking.findUniqueOrThrow({ where: { id: short.id } });
      const payment = await insert(paymentData({ ...row, total: BigInt(row.unitAmountMinor) }));
      await succeed(payment.id, short.id);
      await waitUntilExpired(t.app, short.id);
      const seat = await prisma().bookingSeat.findFirstOrThrow({
        where: { bookingId: short.id },
        include: { locks: true },
      });
      expect(seat.locks).toHaveLength(2);
      await expect(
        prisma().seatInventoryLock.delete({ where: { id: seat.locks[0]!.id } }),
      ).rejects.toThrow(/seat lock of a confirmed booking cannot be deleted/);
      await expect(
        prisma()
          .$executeRaw`DELETE FROM "seat_inventory_lock" WHERE "booking_seat_id" = ${seat.id}::uuid`,
      ).rejects.toThrow(/seat lock of a confirmed booking cannot be deleted/);
      await expect(
        prisma().bookingSeat.update({ where: { id: seat.id }, data: { releasedAt: new Date() } }),
      ).rejects.toThrow(/seat of a confirmed booking cannot be released/);
      await expect(
        prisma().bookingSeat.create({
          data: { bookingId: short.id, seatMapCellId: f.cells['2B']! },
        }),
      ).rejects.toThrow(/seats cannot be added to a confirmed booking/);
      // The PR-09 expired-hold cleanup, run directly, leaves it untouched too.
      await expect(
        prisma().$executeRaw`
          UPDATE "booking_seat" bs SET "released_at" = b."hold_expires_at"
          FROM "booking" b WHERE bs."booking_id" = b."id" AND b."id" = ${short.id}::uuid`,
      ).rejects.toThrow(/seat of a confirmed booking cannot be released/);
      expect(await prisma().seatInventoryLock.count({ where: { bookingSeatId: seat.id } })).toBe(2);
    });

    it('refuses to cancel a trip with a confirmed booking', async () => {
      const f = await fixture();
      await confirmedBooking(f, 2, 4, ['1A']);
      await expect(
        prisma().$executeRaw`
          UPDATE "trip" SET "status" = 'CANCELLED', "cancelled_at" = now() WHERE "id" = ${f.tripId}::uuid`,
      ).rejects.toThrow(/a trip with confirmed bookings cannot be cancelled/);
      expect((await prisma().trip.findUniqueOrThrow({ where: { id: f.tripId } })).status).toBe(
        'SCHEDULED',
      );
    });
  });
});
