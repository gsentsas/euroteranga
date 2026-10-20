import type { Prisma } from '@euroteranga/database';
import { bookingStatus } from '../bookings/booking-rules.js';
import { amountToNumber } from './payment-rules.js';

/** What an attempt's quote says to its payer (PAY-HUB-1); null for PR-10 attempts. */
const paymentQuoteSummarySelect = {
  paymentMethod: true,
  payerCountry: true,
  presentmentAmountMinor: true,
  presentmentCurrencyCode: true,
  presentmentCurrencyMinorUnit: true,
} as const satisfies Prisma.PaymentQuoteSelect;

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
  quote: { select: paymentQuoteSummarySelect },
} as const satisfies Prisma.PaymentSelect;

export type CustomerPaymentRow = Prisma.PaymentGetPayload<{ select: typeof customerPaymentSelect }>;

type QuoteSummary = Prisma.PaymentQuoteGetPayload<{ select: typeof paymentQuoteSummarySelect }>;

/** The method and the amount presented to the payer; null for a PR-10 attempt. */
function quoteSummary(quote: QuoteSummary | null) {
  return quote
    ? {
        paymentMethod: quote.paymentMethod,
        payerCountry: quote.payerCountry,
        presentment: {
          amountMinor: amountToNumber(quote.presentmentAmountMinor),
          currencyCode: quote.presentmentCurrencyCode,
          currencyMinorUnit: quote.presentmentCurrencyMinorUnit,
        },
      }
    : { paymentMethod: null, payerCountry: null, presentment: null };
}

/**
 * What the owning CUSTOMER sees: no internal id, provider, provider id,
 * failure detail, event, signature or secret. amountMinor is the booking
 * amount; presentment is what the payer was asked for. Amounts are JSON
 * numbers only when exact.
 */
export function customerPaymentView(payment: CustomerPaymentRow) {
  return {
    reference: payment.reference,
    status: payment.status,
    amountMinor: amountToNumber(payment.amountMinor),
    currencyCode: payment.currencyCode,
    currencyMinorUnit: payment.currencyMinorUnit,
    ...quoteSummary(payment.quote),
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
  quote: {
    select: {
      id: true,
      ...paymentQuoteSummarySelect,
      fxRate: true,
      fxSource: true,
      quotedAt: true,
      expiresAt: true,
    },
  },
} as const satisfies Prisma.PaymentInclude;

export type AdminPaymentRow = Prisma.PaymentGetPayload<{ include: typeof adminPaymentInclude }>;

/**
 * STAFF view (payment.read): normalized failure code, the provider's opaque
 * id and the quote (method, country, presented amount, rate) for
 * reconciliation; never a payload, signature or secret. The customer stays
 * an opaque identity id.
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
    ...quoteSummary(payment.quote),
    quote: payment.quote
      ? {
          id: payment.quote.id,
          fxRate: payment.quote.fxRate.toFixed(),
          fxSource: payment.quote.fxSource,
          quotedAt: payment.quote.quotedAt,
          expiresAt: payment.quote.expiresAt,
        }
      : null,
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
