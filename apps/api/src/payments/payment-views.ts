import type { Prisma } from '@euroteranga/database';
import { bookingStatus } from '../bookings/booking-rules.js';
import { amountToNumber } from './payment-rules.js';

/** Columns a customer may see of one of their attempts. */
export const customerPaymentSelect = {
  reference: true,
  status: true,
  amountMinor: true,
  currencyCode: true,
  currencyMinorUnit: true,
  createdAt: true,
  succeededAt: true,
  failedAt: true,
  cancelledAt: true,
} as const satisfies Prisma.PaymentSelect;

export type CustomerPaymentRow = Prisma.PaymentGetPayload<{ select: typeof customerPaymentSelect }>;

/**
 * What the owning CUSTOMER sees: no internal id, provider id, failure detail,
 * event, signature or secret. The amount is a JSON number only when exact.
 */
export function customerPaymentView(payment: CustomerPaymentRow) {
  return {
    reference: payment.reference,
    status: payment.status,
    amountMinor: amountToNumber(payment.amountMinor),
    currencyCode: payment.currencyCode,
    currencyMinorUnit: payment.currencyMinorUnit,
    createdAt: payment.createdAt,
    succeededAt: payment.succeededAt,
    failedAt: payment.failedAt,
    cancelledAt: payment.cancelledAt,
  };
}

export const adminPaymentInclude = {
  booking: {
    select: {
      id: true,
      reference: true,
      cancelledAt: true,
      confirmedAt: true,
      holdExpiresAt: true,
    },
  },
} as const satisfies Prisma.PaymentInclude;

export type AdminPaymentRow = Prisma.PaymentGetPayload<{ include: typeof adminPaymentInclude }>;

/**
 * STAFF view (payment.read): normalized failure code and the provider's
 * opaque id for reconciliation, never a payload, signature or secret. The
 * customer stays an opaque identity id.
 */
export function adminPaymentView(payment: AdminPaymentRow, now: Date) {
  return {
    id: payment.id,
    reference: payment.reference,
    status: payment.status,
    provider: payment.provider,
    providerPaymentId: payment.providerPaymentId,
    booking: {
      id: payment.booking.id,
      reference: payment.booking.reference,
      status: bookingStatus(payment.booking, now),
    },
    customerIdentityId: payment.customerIdentityId,
    amountMinor: amountToNumber(payment.amountMinor),
    currencyCode: payment.currencyCode,
    currencyMinorUnit: payment.currencyMinorUnit,
    failureCode: payment.failureCode,
    createdAt: payment.createdAt,
    succeededAt: payment.succeededAt,
    failedAt: payment.failedAt,
    cancelledAt: payment.cancelledAt,
  };
}

/** Provider events of an attempt: what happened and when, no payload. */
export const paymentEventSelect = {
  id: true,
  type: true,
  providerEventId: true,
  receivedAt: true,
  processedAt: true,
  rejectionCode: true,
} as const satisfies Prisma.PaymentEventSelect;
