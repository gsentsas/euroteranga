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
import type { PaymentProviderName, ProviderEvent } from './providers/payment-provider.js';

/**
 * Result of one provider event. Some refusals are recorded first (the event
 * row, and possibly a FAILED attempt, are committed) and only then reported
 * to the provider as an error.
 */
export type WebhookOutcome =
  | { outcome: 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED'; error?: undefined }
  | { outcome: 'REJECTED'; error: PublicApiError };

interface LockedPayment {
  id: string;
  reference: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  booking_id: string;
  amount_minor: bigint;
  currency_code: string;
}

interface LockedBooking {
  id: string;
  reference: string;
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

  private async apply(
    tx: DatabaseTransaction,
    provider: PaymentProviderName,
    event: ProviderEvent,
  ): Promise<WebhookOutcome> {
    const [payment] = await tx.$queryRaw<LockedPayment[]>`
      SELECT "id", "reference", "status"::text AS "status", "booking_id", "amount_minor",
        "currency_code"
      FROM "payment"
      WHERE "provider" = ${provider}::"payment_provider"
        AND "provider_payment_id" = ${event.providerPaymentId}
      FOR UPDATE
    `;
    if (!payment) throw PaymentErrors.notFound();
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

    if (event.amountMinor !== payment.amount_minor) {
      return reject('AMOUNT_MISMATCH', PaymentErrors.webhookInvalid(422));
    }
    if (event.currencyCode !== payment.currency_code) {
      return reject('CURRENCY_MISMATCH', PaymentErrors.webhookInvalid(422));
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
      SELECT "id", "reference", "cancelled_at", "confirmed_at", "hold_expires_at"
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
