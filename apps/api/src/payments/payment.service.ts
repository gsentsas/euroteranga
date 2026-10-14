import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { BookingErrors } from '../bookings/booking.errors.js';
import { databaseNow } from '../bookings/booking-inventory.js';
import { normalizeBookingReference, withFreshReference } from '../bookings/booking-rules.js';
import { DatabaseService } from '../database/database.service.js';
import type { AdminPaymentListQuery } from './payment.dto.js';
import { PaymentErrors } from './payment.errors.js';
import {
  amountToNumber,
  bookingAmountMinor,
  generatePaymentReference,
  normalizePaymentReference,
  parseIdempotencyKey,
} from './payment-rules.js';
import { cancelPendingPayments } from './payment-transitions.js';
import {
  adminPaymentInclude,
  adminPaymentView,
  customerPaymentSelect,
  customerPaymentView,
  paymentEventSelect,
} from './payment-views.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderCheckout,
} from './providers/payment-provider.js';

const CUSTOMER_CANCELLATION_REASON = 'Tentative annulée par le client';

/** Which unique index a P2002 error comes from (driver-adapter aware). */
function uniqueViolationOn(error: unknown, ...fragments: string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const details = JSON.stringify(error.meta ?? {});
  return fragments.some((fragment) => details.includes(fragment));
}

/** Expected database failures become stable public errors. */
function translate(error: unknown): never {
  if (error instanceof PublicApiError) throw error;
  if (uniqueViolationOn(error, 'payment_one_pending_per_booking')) {
    throw PaymentErrors.alreadyPending();
  }
  if (uniqueViolationOn(error, 'payment_one_succeeded_per_booking')) {
    throw PaymentErrors.alreadySucceeded();
  }
  throw error;
}

export interface CreatePaymentResult {
  payment: ReturnType<typeof customerPaymentView>;
  /** What the browser does next. SANDBOX collects nothing: await the provider event. */
  checkout: { provider: string; testMode: boolean; redirectUrl: string | null };
}

interface LockedBooking {
  id: string;
  reference: string;
  cancelled_at: Date | null;
  confirmed_at: Date | null;
  hold_expires_at: Date;
  unit_amount_minor: number;
  currency_code: string;
  currency_minor_unit: number;
}

interface LockedPayment {
  id: string;
  reference: string;
  status: string;
  booking_reference: string;
}

interface LockedProviderPayment {
  id: string;
  status: string;
  provider_payment_id: string | null;
}

/** Everything needed after the database has reserved an initiation. */
const reservedPaymentSelect = {
  id: true,
  provider: true,
  providerPaymentId: true,
  booking: { select: { reference: true } },
  ...customerPaymentSelect,
} as const satisfies Prisma.PaymentSelect;

type ReservedPayment = Prisma.PaymentGetPayload<{ select: typeof reservedPaymentSelect }>;

interface PaymentReservation {
  replayed: boolean;
  payment: ReservedPayment;
}

/**
 * Payment attempts of authenticated CUSTOMERs and their STAFF reading. The
 * server derives every amount from the booking; a result (success or
 * failure) only ever comes from a provider event (PaymentWebhookService).
 * Every mutation and its audit event share one transaction.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
  ) {}

  /**
   * Starts an attempt for a HELD booking of the caller in three phases:
   * reserve and audit the PENDING row in a short transaction; call the
   * provider after that transaction commits; attach its id in another short
   * transaction. Payment.reference is the provider-side idempotency key, so
   * a lost provider response can be recovered by replaying Idempotency-Key.
   */
  async create(
    actor: AuthPrincipal,
    rawReference: string,
    rawIdempotencyKey: string | string[] | undefined,
  ): Promise<{ replayed: boolean; result: CreatePaymentResult }> {
    const provider = this.provider;
    if (!provider) throw PaymentErrors.providerUnavailable();
    const reference = normalizeBookingReference(rawReference);
    if (!reference) throw BookingErrors.notFound();
    const idempotencyKey = parseIdempotencyKey(rawIdempotencyKey);
    if (idempotencyKey === null) throw PaymentErrors.idempotencyKeyInvalid();

    // This lookup only resolves the immutable lock targets. All payable-state
    // checks and the amount derivation happen again under the Phase A locks.
    const booking = await this.database.client.booking.findFirst({
      where: { reference, customerIdentityId: actor.identityId },
      select: { id: true, tripId: true },
    });
    if (!booking) throw BookingErrors.notFound();

    const reservation = await this.reservePayment({
      actor,
      provider,
      bookingId: booking.id,
      tripId: booking.tripId,
      bookingReference: reference,
      idempotencyKey,
    });
    const result = await this.createAtProvider(provider, reservation.payment);
    return { replayed: reservation.replayed, result };
  }

  /** Phase A: reserve the attempt and commit before any provider call. */
  private async reservePayment(input: {
    actor: AuthPrincipal;
    provider: PaymentProvider;
    bookingId: string;
    tripId: string;
    bookingReference: string;
    idempotencyKey: string | undefined;
  }): Promise<PaymentReservation> {
    try {
      return await withFreshReference(
        async (paymentReference) => {
          return this.database.client.$transaction((tx) =>
            this.reserveInTransaction(tx, { ...input, paymentReference }),
          );
        },
        (error) => uniqueViolationOn(error, 'payment_reference_key'),
        generatePaymentReference,
      );
    } catch (error) {
      // A concurrent request with the same key won the race: same attempt.
      if (input.idempotencyKey && uniqueViolationOn(error, 'idempotency_key')) {
        const replay = await this.replay(
          this.database.client,
          input.actor,
          input.bookingReference,
          input.idempotencyKey,
        );
        if (replay) return { replayed: true, payment: replay };
      }
      return translate(error);
    }
  }

  private async reserveInTransaction(
    tx: DatabaseTransaction,
    input: {
      actor: AuthPrincipal;
      provider: PaymentProvider;
      paymentReference: string;
      bookingId: string;
      tripId: string;
      bookingReference: string;
      idempotencyKey: string | undefined;
    },
  ): Promise<PaymentReservation> {
    const { actor } = input;
    // Lock order: trip (shared) -> booking -> new payment row.
    const [trip] = await tx.$queryRaw<Array<{ status: string; planned_departure_at: Date | null }>>`
      SELECT "status"::text AS "status", "planned_departure_at"
      FROM "trip" WHERE "id" = ${input.tripId}::uuid
      FOR SHARE
    `;
    const [booking] = await tx.$queryRaw<LockedBooking[]>`
      SELECT "id", "reference", "cancelled_at", "confirmed_at", "hold_expires_at",
        "unit_amount_minor", "currency_code", "currency_minor_unit"
      FROM "booking"
      WHERE "id" = ${input.bookingId}::uuid AND "customer_identity_id" = ${actor.identityId}::uuid
      FOR UPDATE
    `;
    if (!booking) throw BookingErrors.notFound();

    // Evaluate the complete payable state from the locked rows. An exact-key
    // replay still wins over a later terminal state, preserving the original
    // idempotency contract, but it never calls the provider unless PENDING.
    const now = await databaseNow(tx);
    const stateError = booking.cancelled_at
      ? PaymentErrors.bookingNotPayable()
      : booking.confirmed_at
        ? PaymentErrors.bookingConfirmed()
        : booking.hold_expires_at.getTime() <= now.getTime()
          ? PaymentErrors.bookingExpired()
          : trip?.status !== 'SCHEDULED' ||
              !trip.planned_departure_at ||
              trip.planned_departure_at.getTime() <= now.getTime()
            ? PaymentErrors.bookingNotPayable()
            : null;
    if (input.idempotencyKey) {
      const replay = await this.replay(tx, actor, booking.reference, input.idempotencyKey);
      if (replay) return { replayed: true, payment: replay };
    }
    if (stateError) throw stateError;
    const pending = await tx.payment.findFirst({
      where: { bookingId: booking.id, status: 'PENDING' },
      select: { id: true },
    });
    if (pending) throw PaymentErrors.alreadyPending();

    // Derived from the locked booking only: unit fare x seats (BigInt).
    const seatCount = await tx.bookingSeat.count({ where: { bookingId: booking.id } });
    const amountMinor = bookingAmountMinor(booking.unit_amount_minor, seatCount);
    const payment = await tx.payment.create({
      data: {
        reference: input.paymentReference,
        bookingId: booking.id,
        customerIdentityId: actor.identityId,
        provider: input.provider.name,
        providerPaymentId: null,
        amountMinor,
        currencyCode: booking.currency_code,
        currencyMinorUnit: booking.currency_minor_unit,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        createdAt: now,
      },
      select: reservedPaymentSelect,
    });
    await this.audit.record(
      {
        actor,
        action: 'PAYMENT_CREATED',
        resourceType: 'payment',
        resourceId: payment.id,
        after: {
          reference: payment.reference,
          status: 'PENDING',
          provider: input.provider.name,
          bookingReference: booking.reference,
          seatCount,
          amountMinor: amountToNumber(amountMinor),
          currencyCode: booking.currency_code,
          currencyMinorUnit: booking.currency_minor_unit,
        },
        metadata: { idempotencyKeyUsed: Boolean(input.idempotencyKey) },
      },
      tx,
    );
    return { replayed: false, payment };
  }

  /**
   * Phase B: no database transaction or lock is held during this call.
   * Replays of a PENDING attempt intentionally call again with the same
   * Payment.reference; the provider contract makes that operation idempotent.
   */
  private async createAtProvider(
    provider: PaymentProvider,
    reserved: ReservedPayment,
  ): Promise<CreatePaymentResult> {
    if (reserved.status !== 'PENDING') {
      return this.createResult(provider, reserved, null);
    }
    const checkout = await provider.createPayment({
      paymentReference: reserved.reference,
      bookingReference: reserved.booking.reference,
      amountMinor: reserved.amountMinor,
      currencyCode: reserved.currencyCode,
      currencyMinorUnit: reserved.currencyMinorUnit,
    });
    const payment = await this.database.client.$transaction((tx) =>
      this.attachProviderPaymentId(tx, reserved.id, checkout),
    );
    return this.createResult(provider, payment, checkout.redirectUrl);
  }

  /** Phase C: attach the provider id once, while the attempt is still PENDING. */
  private async attachProviderPaymentId(
    tx: DatabaseTransaction,
    paymentId: string,
    checkout: ProviderCheckout,
  ): Promise<ReservedPayment> {
    const [locked] = await tx.$queryRaw<LockedProviderPayment[]>`
      SELECT "id", "status"::text AS "status", "provider_payment_id"
      FROM "payment" WHERE "id" = ${paymentId}::uuid
      FOR UPDATE
    `;
    if (!locked) throw PaymentErrors.notFound();
    if (locked.status !== 'PENDING') throw PaymentErrors.invalidTransition();
    if (
      locked.provider_payment_id !== null &&
      locked.provider_payment_id !== checkout.providerPaymentId
    ) {
      throw new Error('payment provider returned another id for the same payment reference');
    }
    if (locked.provider_payment_id === null) {
      return tx.payment.update({
        where: { id: paymentId },
        data: { providerPaymentId: checkout.providerPaymentId },
        select: reservedPaymentSelect,
      });
    }
    return tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: reservedPaymentSelect,
    });
  }

  private createResult(
    provider: PaymentProvider,
    payment: ReservedPayment,
    redirectUrl: string | null,
  ): CreatePaymentResult {
    return {
      payment: customerPaymentView(payment),
      checkout: { provider: provider.name, testMode: provider.testMode, redirectUrl },
    };
  }

  /**
   * The attempt already started with this key by this customer, if any. A key
   * reused for another booking is refused rather than silently ignored.
   */
  private async replay(
    client: DatabaseTransaction,
    actor: AuthPrincipal,
    bookingReference: string,
    idempotencyKey: string,
  ): Promise<ReservedPayment | null> {
    const existing = await client.payment.findUnique({
      where: {
        customerIdentityId_idempotencyKey: {
          customerIdentityId: actor.identityId,
          idempotencyKey,
        },
      },
      select: reservedPaymentSelect,
    });
    if (!existing) return null;
    if (existing.booking.reference !== bookingReference) throw PaymentErrors.idempotencyKeyReused();
    return existing;
  }

  /** Attempts of one of the caller's bookings, newest first. */
  async customerPayments(actor: AuthPrincipal, rawReference: string) {
    const reference = normalizeBookingReference(rawReference);
    if (!reference) throw BookingErrors.notFound();
    const booking = await this.database.client.booking.findFirst({
      where: { reference, customerIdentityId: actor.identityId },
      select: {
        payments: { orderBy: { id: 'desc' }, take: 50, select: customerPaymentSelect },
      },
    });
    if (!booking) throw BookingErrors.notFound();
    return { items: booking.payments.map(customerPaymentView) };
  }

  /** The owner gives up a PENDING attempt; the booking stays HELD. */
  async cancelByCustomer(actor: AuthPrincipal, rawReference: string) {
    const reference = normalizePaymentReference(rawReference);
    if (!reference) throw PaymentErrors.notFound();
    await this.cancel(
      (tx) => tx.$queryRaw<LockedPayment[]>`
        SELECT p."id", p."reference", p."status"::text AS "status",
          b."reference" AS "booking_reference"
        FROM "payment" p JOIN "booking" b ON b."id" = p."booking_id"
        WHERE p."reference" = ${reference}
          AND p."customer_identity_id" = ${actor.identityId}::uuid
        FOR UPDATE OF p
      `,
      { actor, reason: CUSTOMER_CANCELLATION_REASON, cancelledBy: 'CUSTOMER' },
    );
    const payment = await this.database.client.payment.findUniqueOrThrow({
      where: { reference },
      select: customerPaymentSelect,
    });
    return customerPaymentView(payment);
  }

  /** payment.manage: give up a PENDING attempt, with a reason. Never "mark paid". */
  async cancelByStaff(actor: AuthPrincipal, id: string, reason: string) {
    await this.cancel(
      (tx) => tx.$queryRaw<LockedPayment[]>`
        SELECT p."id", p."reference", p."status"::text AS "status",
          b."reference" AS "booking_reference"
        FROM "payment" p JOIN "booking" b ON b."id" = p."booking_id"
        WHERE p."id" = ${id}::uuid
        FOR UPDATE OF p
      `,
      { actor, reason, cancelledBy: 'STAFF' },
    );
    return this.adminPayment(id);
  }

  /** Lock order: payment only (the booking does not change). */
  private async cancel(
    lock: (tx: DatabaseTransaction) => Promise<LockedPayment[]>,
    input: { actor: AuthPrincipal; reason: string; cancelledBy: 'CUSTOMER' | 'STAFF' },
  ) {
    await this.database.client.$transaction(async (tx) => {
      const [payment] = await lock(tx);
      if (!payment) throw PaymentErrors.notFound();
      if (payment.status !== 'PENDING') throw PaymentErrors.invalidTransition();
      await cancelPendingPayments(
        tx,
        this.audit,
        [
          {
            id: payment.id,
            reference: payment.reference,
            bookingReference: payment.booking_reference,
          },
        ],
        input,
      );
    });
  }

  async adminPayments(query: AdminPaymentListQuery) {
    const client = this.database.client;
    const [rows, now] = await Promise.all([
      client.payment.findMany({
        take: query.limit + 1,
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.paymentReference ? { reference: query.paymentReference } : {}),
          ...(query.bookingReference ? { booking: { reference: query.bookingReference } } : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        include: adminPaymentInclude,
      }),
      databaseNow(client),
    ]);
    const items = rows.slice(0, query.limit).map((row) => adminPaymentView(row, now));
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async adminPayment(id: string) {
    const client = this.database.client;
    const [row, now] = await Promise.all([
      client.payment.findUnique({
        where: { id },
        include: {
          ...adminPaymentInclude,
          events: { orderBy: { id: 'asc' }, select: paymentEventSelect },
        },
      }),
      databaseNow(client),
    ]);
    if (!row) throw PaymentErrors.notFound();
    return { ...adminPaymentView(row, now), events: row.events };
  }

  /** Attempts of a booking for STAFF holding payment.read (booking detail). */
  async adminBookingPayments(bookingId: string) {
    const client = this.database.client;
    const [rows, now] = await Promise.all([
      client.payment.findMany({
        where: { bookingId },
        orderBy: { id: 'desc' },
        include: adminPaymentInclude,
      }),
      databaseNow(client),
    ]);
    return rows.map((row) => adminPaymentView(row, now));
  }
}
