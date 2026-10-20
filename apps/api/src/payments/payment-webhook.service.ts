import { Prisma, type DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { PublicApiError } from '../auth/http/public-api-error.js';
import { AuditService } from '../authorization/audit.service.js';
import { databaseNow } from '../bookings/booking-inventory.js';
import { DatabaseService } from '../database/database.service.js';
import { PaymentErrors } from './payment.errors.js';
import {
  amountToNumber,
  type PaymentEventRejection,
  type PaymentFailureCode,
} from './payment-rules.js';
import type {
  PaymentProviderName,
  ProviderApproval,
  ProviderEvent,
} from './providers/payment-provider.js';

/** Audit action of a capture request (PAY-PAYPAL-1); such an attempt is no longer cancellable. */
export const PAYMENT_CAPTURE_REQUESTED = 'PAYMENT_CAPTURE_REQUESTED';
/** Hold time that must still remain when EURO TERANGA asks a provider to capture. */
export const CAPTURE_HOLD_MARGIN_SECONDS = 60;

/** Why an approval is not captured. Nothing is collected and nothing changes. */
export type CaptureRefusal =
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_NOT_PENDING'
  | 'BOOKING_NOT_PAYABLE'
  | 'BOOKING_EXPIRED'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH';

export type CaptureDecision =
  | { capture: true; paymentReference: string; providerPaymentId: string }
  | { capture: false; refusal: CaptureRefusal };

/**
 * Result of one provider event. Some refusals are recorded first (the event
 * row, and possibly a FAILED attempt, are committed) and only then reported
 * to the provider as an error.
 */
export type WebhookOutcome =
  | { outcome: 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED'; error?: undefined }
  | { outcome: 'REJECTED'; error: PublicApiError };

export interface LockedPayment {
  id: string;
  reference: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  booking_id: string;
  amount_minor: bigint;
  currency_code: string;
  currency_minor_unit: number;
  quote_id: string | null;
  quote_booking_amount_minor: bigint | null;
  quote_booking_currency_code: string | null;
  quote_booking_currency_minor_unit: number | null;
  presentment_amount_minor: bigint | null;
  presentment_currency_code: string | null;
}

/**
 * What the provider must have collected. With a quote (PAY-HUB-1): its
 * presentment amount and currency, the quote itself covering exactly the
 * payment's booking amount. Without one (a PR-10 attempt): the payment amount.
 */
export function expectedProviderAmount(
  payment: LockedPayment,
): { amountMinor: bigint; currencyCode: string } | null {
  if (payment.quote_id === null) {
    return { amountMinor: payment.amount_minor, currencyCode: payment.currency_code };
  }
  if (
    payment.presentment_amount_minor === null ||
    payment.presentment_currency_code === null ||
    payment.quote_booking_amount_minor !== payment.amount_minor ||
    payment.quote_booking_currency_code !== payment.currency_code ||
    payment.quote_booking_currency_minor_unit !== payment.currency_minor_unit
  ) {
    return null;
  }
  return {
    amountMinor: payment.presentment_amount_minor,
    currencyCode: payment.presentment_currency_code,
  };
}

interface LockedBooking {
  id: string;
  reference: string;
  trip_id: string;
  cancelled_at: Date | null;
  confirmed_at: Date | null;
  hold_expires_at: Date;
}

/**
 * The only path to SUCCEEDED and FAILED: authenticated, idempotent provider
 * events. One transaction per event, lock order payment -> booking (like
 * every other path: trip -> payment -> booking). Audit events have no actor
 * (system) and carry the provider event id, never a signature or secret.
 */
@Injectable()
export class PaymentWebhookService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async process(provider: PaymentProviderName, event: ProviderEvent): Promise<WebhookOutcome> {
    try {
      return await this.database.client.$transaction((tx) => this.apply(tx, provider, event));
    } catch (error) {
      // Same event id racing on two different payments: still a replay.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        JSON.stringify(error.meta ?? {}).includes('provider_event_id')
      ) {
        throw PaymentErrors.webhookReplay();
      }
      throw error;
    }
  }

  /**
   * The payload hash recorded for a provider event id, if any: tells a
   * provider's redelivery of the very same event (acknowledged) from another
   * payload reusing its id (refused).
   */
  async recordedPayloadHash(
    provider: PaymentProviderName,
    providerEventId: string,
  ): Promise<string | null> {
    const recorded = await this.database.client.paymentEvent.findUnique({
      where: { provider_providerEventId: { provider, providerEventId } },
      select: { payloadHash: true },
    });
    return recorded?.payloadHash ?? null;
  }

  /**
   * PAY-PAYPAL-1: whether an authenticated approval may be captured, decided
   * in one short transaction on the locked rows: the attempt is still
   * PENDING, the approved amount (when the provider states it) is the
   * quote's presentment, the booking is still an active hold with at least
   * CAPTURE_HOLD_MARGIN_SECONDS left, and its trip is still payable. A
   * capture request is then recorded in the audit trail, and from then on
   * the attempt can no longer be cancelled: the provider is called after
   * commit, outside any transaction. Nothing here confirms anything.
   */
  async prepareCapture(
    provider: PaymentProviderName,
    approval: ProviderApproval,
  ): Promise<CaptureDecision> {
    return this.database.client.$transaction(async (tx) => {
      const refuse = (refusal: CaptureRefusal) => ({ capture: false, refusal }) as const;
      const payment = await this.lockPayment(tx, provider, approval.providerPaymentId);
      if (!payment) return refuse('PAYMENT_NOT_FOUND');
      if (payment.status !== 'PENDING') return refuse('PAYMENT_NOT_PENDING');
      const expected = expectedProviderAmount(payment);
      if (!expected) return refuse('AMOUNT_MISMATCH');
      if (approval.amountMinor !== null && approval.amountMinor !== expected.amountMinor) {
        return refuse('AMOUNT_MISMATCH');
      }
      if (approval.currencyCode !== null && approval.currencyCode !== expected.currencyCode) {
        return refuse('CURRENCY_MISMATCH');
      }
      const [booking] = await tx.$queryRaw<LockedBooking[]>`
        SELECT "id", "reference", "trip_id", "cancelled_at", "confirmed_at", "hold_expires_at"
        FROM "booking" WHERE "id" = ${payment.booking_id}::uuid
        FOR UPDATE
      `;
      if (!booking || booking.cancelled_at || booking.confirmed_at) {
        return refuse('BOOKING_NOT_PAYABLE');
      }
      const now = await databaseNow(tx);
      if (booking.hold_expires_at.getTime() - now.getTime() < CAPTURE_HOLD_MARGIN_SECONDS * 1000) {
        return refuse('BOOKING_EXPIRED');
      }
      // Read without a lock (the lock order is trip -> payment -> booking).
      const [trip] = await tx.$queryRaw<
        Array<{ status: string; planned_departure_at: Date | null }>
      >`
        SELECT "status"::text AS "status", "planned_departure_at"
        FROM "trip" WHERE "id" = ${booking.trip_id}::uuid
      `;
      if (
        trip?.status !== 'SCHEDULED' ||
        !trip.planned_departure_at ||
        trip.planned_departure_at.getTime() <= now.getTime()
      ) {
        return refuse('BOOKING_NOT_PAYABLE');
      }
      await this.audit.record(
        {
          action: PAYMENT_CAPTURE_REQUESTED,
          resourceType: 'payment',
          resourceId: payment.id,
          metadata: {
            provider,
            providerEventId: approval.providerEventId,
            paymentReference: payment.reference,
            bookingReference: booking.reference,
          },
        },
        tx,
      );
      return {
        capture: true,
        paymentReference: payment.reference,
        providerPaymentId: approval.providerPaymentId,
      };
    });
  }

  /** The attempt of a provider id, locked; its immutable quote is read without a lock. */
  private async lockPayment(
    tx: DatabaseTransaction,
    provider: PaymentProviderName,
    providerPaymentId: string,
  ): Promise<LockedPayment | undefined> {
    const [payment] = await tx.$queryRaw<LockedPayment[]>`
      SELECT p."id", p."reference", p."status"::text AS "status", p."booking_id",
        p."amount_minor", p."currency_code", p."currency_minor_unit", p."quote_id",
        q."booking_amount_minor" AS "quote_booking_amount_minor",
        q."booking_currency_code" AS "quote_booking_currency_code",
        q."booking_currency_minor_unit" AS "quote_booking_currency_minor_unit",
        q."presentment_amount_minor", q."presentment_currency_code"
      FROM "payment" p
      LEFT JOIN "payment_quote" q ON q."id" = p."quote_id"
      WHERE p."provider" = ${provider}::"payment_provider"
        AND p."provider_payment_id" = ${providerPaymentId}
      FOR UPDATE OF p
    `;
    return payment;
  }

  private async apply(
    tx: DatabaseTransaction,
    provider: PaymentProviderName,
    event: ProviderEvent,
  ): Promise<WebhookOutcome> {
    const payment = await this.lockPayment(tx, provider, event.providerPaymentId);
    if (!payment) throw PaymentErrors.notFound();
    // Some providers (Wave) echo our immutable reference. It must identify
    // the same attempt as the provider id; either identifier alone is not
    // sufficient when both are available.
    if (event.paymentReference !== undefined && event.paymentReference !== payment.reference) {
      throw PaymentErrors.webhookInvalid(422);
    }
    // Events of one payment are serialized by its lock: this check is exact.
    const seen = await tx.paymentEvent.findUnique({
      where: { provider_providerEventId: { provider, providerEventId: event.providerEventId } },
      select: { id: true },
    });
    if (seen) throw PaymentErrors.webhookReplay();

    const now = await databaseNow(tx);
    const record = (outcome: { rejectionCode: PaymentEventRejection } | { processed: true }) =>
      tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          provider,
          providerEventId: event.providerEventId,
          type: event.type,
          payloadHash: event.payloadHash,
          receivedAt: now,
          ...('processed' in outcome
            ? { processedAt: now }
            : { rejectionCode: outcome.rejectionCode }),
        },
        select: { id: true },
      });
    const reject = async (code: PaymentEventRejection, error: PublicApiError) => {
      await record({ rejectionCode: code });
      return { outcome: 'REJECTED', error } as const;
    };

    // Exactly the amount the payer was asked for, in that currency. A
    // failure that states no amount (it moved no money) has nothing to check.
    const expected = expectedProviderAmount(payment);
    if (event.type === 'PAYMENT_SUCCEEDED' || event.amountMinor !== null) {
      if (!expected || event.amountMinor !== expected.amountMinor) {
        return reject('AMOUNT_MISMATCH', PaymentErrors.webhookInvalid(422));
      }
      if (event.currencyCode !== expected.currencyCode) {
        return reject('CURRENCY_MISMATCH', PaymentErrors.webhookInvalid(422));
      }
    }
    if (payment.status !== 'PENDING') {
      return payment.status === 'SUCCEEDED' && event.type === 'PAYMENT_SUCCEEDED'
        ? reject('PAYMENT_ALREADY_SUCCEEDED', PaymentErrors.alreadySucceeded())
        : reject('PAYMENT_NOT_PENDING', PaymentErrors.invalidTransition());
    }

    if (event.type === 'PAYMENT_FAILED') {
      // The booking stays HELD until its expiry: the customer may try again.
      await record({ processed: true });
      await this.fail(tx, payment, event, event.failureCode ?? 'UNKNOWN', now);
      return { outcome: 'PAYMENT_FAILED' };
    }

    const [booking] = await tx.$queryRaw<LockedBooking[]>`
      SELECT "id", "reference", "trip_id", "cancelled_at", "confirmed_at", "hold_expires_at"
      FROM "booking" WHERE "id" = ${payment.booking_id}::uuid
      FOR UPDATE
    `;
    // A success can only confirm a booking that is still an active hold.
    if (!booking || booking.cancelled_at || booking.confirmed_at) {
      await record({ processed: true });
      await this.fail(tx, payment, event, 'BOOKING_NOT_PAYABLE', now);
      return {
        outcome: 'REJECTED',
        error: booking?.confirmed_at
          ? PaymentErrors.bookingConfirmed()
          : PaymentErrors.bookingNotPayable(),
      };
    }
    if (booking.hold_expires_at.getTime() <= now.getTime()) {
      await record({ processed: true });
      await this.fail(tx, payment, event, 'BOOKING_EXPIRED', now);
      return { outcome: 'REJECTED', error: PaymentErrors.bookingExpired() };
    }

    // Checked above for every success: exactly the quote's presentment.
    const collected = expected;
    if (!collected) return reject('AMOUNT_MISMATCH', PaymentErrors.webhookInvalid(422));
    await record({ processed: true });
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCEEDED', succeededAt: now },
    });
    await tx.booking.update({ where: { id: booking.id }, data: { confirmedAt: now } });
    const amount = amountToNumber(payment.amount_minor);
    const metadata = {
      provider,
      providerEventId: event.providerEventId,
      paymentReference: payment.reference,
      bookingReference: booking.reference,
    };
    await this.audit.record(
      {
        action: 'PAYMENT_SUCCEEDED',
        resourceType: 'payment',
        resourceId: payment.id,
        before: { status: 'PENDING' },
        after: {
          status: 'SUCCEEDED',
          succeededAt: now,
          amountMinor: amount,
          currencyCode: payment.currency_code,
          collectedAmountMinor: amountToNumber(collected.amountMinor),
          collectedCurrencyCode: collected.currencyCode,
        },
        metadata,
      },
      tx,
    );
    await this.audit.record(
      {
        action: 'BOOKING_CONFIRMED',
        resourceType: 'booking',
        resourceId: booking.id,
        before: { status: 'HELD' },
        after: { status: 'CONFIRMED', confirmedAt: now },
        metadata: { ...metadata, amountMinor: amount, currencyCode: payment.currency_code },
      },
      tx,
    );
    return { outcome: 'PAYMENT_SUCCEEDED' };
  }

  private async fail(
    tx: DatabaseTransaction,
    payment: LockedPayment,
    event: ProviderEvent,
    failureCode: PaymentFailureCode,
    now: Date,
  ): Promise<void> {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'FAILED', failedAt: now, failureCode },
    });
    await this.audit.record(
      {
        action: 'PAYMENT_FAILED',
        resourceType: 'payment',
        resourceId: payment.id,
        before: { status: 'PENDING' },
        after: { status: 'FAILED', failedAt: now, failureCode },
        metadata: {
          providerEventId: event.providerEventId,
          eventType: event.type,
          paymentReference: payment.reference,
        },
      },
      tx,
    );
  }
}
