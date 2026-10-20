import type { DatabaseTransaction, Prisma } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { customerIdentityOf, type CustomerActor } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { BookingErrors } from '../bookings/booking.errors.js';
import { databaseNow } from '../bookings/booking-inventory.js';
import { normalizeBookingReference } from '../bookings/booking-rules.js';
import { DatabaseService } from '../database/database.service.js';
import type { PaymentQuoteCreate } from './payment.dto.js';
import { PaymentErrors } from './payment.errors.js';
import { PaymentCapabilityRegistry } from './payment-capability.registry.js';
import {
  isPayerCountry,
  methodGroup,
  methodOffered,
  methodsForCountry,
  PRESENTMENT_CURRENCIES,
  type PayerCountry,
} from './payment-catalog.js';
import { PaymentFxService } from './payment-fx.service.js';
import { amountToNumber, bookingAmountMinor, holdRemaining } from './payment-rules.js';

/** How long a quoted amount stays valid, never beyond the booking hold. */
export const PAYMENT_QUOTE_TTL_SECONDS = 600;
/** Bound on the quotes of one booking (each request stores an immutable row). */
export const MAX_QUOTES_PER_BOOKING = 50;

/** The earlier of the quote lifetime and the hold expiry. */
export function quoteExpiry(quotedAt: Date, holdExpiresAt: Date): Date {
  const end = new Date(quotedAt.getTime() + PAYMENT_QUOTE_TTL_SECONDS * 1000);
  return end.getTime() < holdExpiresAt.getTime() ? end : holdExpiresAt;
}

export const paymentQuoteSelect = {
  id: true,
  paymentMethod: true,
  payerCountry: true,
  bookingAmountMinor: true,
  bookingCurrencyCode: true,
  bookingCurrencyMinorUnit: true,
  presentmentAmountMinor: true,
  presentmentCurrencyCode: true,
  presentmentCurrencyMinorUnit: true,
  fxRate: true,
  fxSource: true,
  quotedAt: true,
  expiresAt: true,
} as const satisfies Prisma.PaymentQuoteSelect;

export type PaymentQuoteRow = Prisma.PaymentQuoteGetPayload<{
  select: typeof paymentQuoteSelect;
}>;

/**
 * What the payer sees of a quote: both amounts, the rate and its validity.
 * The internal provider candidate and routing are never part of it.
 */
export function customerQuoteView(quote: PaymentQuoteRow) {
  return {
    id: quote.id,
    paymentMethod: quote.paymentMethod,
    payerCountry: quote.payerCountry,
    booking: {
      amountMinor: amountToNumber(quote.bookingAmountMinor),
      currencyCode: quote.bookingCurrencyCode,
      currencyMinorUnit: quote.bookingCurrencyMinorUnit,
    },
    presentment: {
      amountMinor: amountToNumber(quote.presentmentAmountMinor),
      currencyCode: quote.presentmentCurrencyCode,
      currencyMinorUnit: quote.presentmentCurrencyMinorUnit,
    },
    fxRate: quote.fxRate.toFixed(),
    fxSource: quote.fxSource,
    quotedAt: quote.quotedAt,
    expiresAt: quote.expiresAt,
  };
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

/**
 * PAY-HUB-1: what a payer of a country can use for one of their bookings, and
 * the immutable quote of the amount they will be asked for. A quote takes no
 * money and confirms nothing; the client only states intentions (country and
 * method), the server computes every amount.
 */
@Injectable()
export class PaymentQuoteService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly registry: PaymentCapabilityRegistry,
    private readonly fx: PaymentFxService,
  ) {}

  /**
   * The catalogue of a payer country for one of the caller's bookings. A
   * method is available only when a configured provider collects it here, in
   * the presentment currency, and the amount can be converted. No provider
   * name, priority, credential or configuration detail is returned.
   */
  async options(actor: CustomerActor, rawReference: string, rawCountry: string) {
    const country = this.payerCountry(rawCountry);
    const booking = await this.database.client.booking.findFirst({
      where: {
        reference: this.bookingReference(rawReference),
        customerIdentityId: customerIdentityOf(actor),
      },
      select: {
        unitAmountMinor: true,
        currencyCode: true,
        currencyMinorUnit: true,
        holdExpiresAt: true,
        _count: { select: { seats: true } },
      },
    });
    if (!booking) throw BookingErrors.notFound();
    const presentment = PRESENTMENT_CURRENCIES[country];
    const converted = this.fx.convert({
      amountMinor: bookingAmountMinor(booking.unitAmountMinor, booking._count.seats),
      fromCurrency: booking.currencyCode,
      fromMinorUnit: booking.currencyMinorUnit,
      toCurrency: presentment.code,
      toMinorUnit: presentment.minorUnit,
    });
    const now = await databaseNow(this.database.client);
    const holdRemainingSeconds = holdRemaining(booking.holdExpiresAt, now);
    return {
      country,
      currency: presentment.code,
      currencyMinorUnit: presentment.minorUnit,
      methods: methodsForCountry(country).map((descriptor) => {
        const route = converted
          ? this.registry.route({
              method: descriptor.code,
              payerCountry: country,
              currencyCode: presentment.code,
              presentmentAmountMinor: converted.presentmentAmountMinor,
              holdRemainingSeconds,
            })
          : null;
        // Card badges and device wallets come from the provider that would
        // collect the card, never from the catalogue: no promise without one.
        const card = descriptor.code === 'CARD' && route ? route.capability : null;
        return {
          code: descriptor.code,
          label: descriptor.label,
          group: methodGroup(descriptor, country),
          available: route !== null,
          acceptedNetworks: card?.cardNetworks[country] ?? [],
          deviceWallets: card?.deviceWallets ?? [],
        };
      }),
    };
  }

  /** Quotes the exact amount of an active hold for a country and a method. */
  async create(actor: CustomerActor, rawReference: string, input: PaymentQuoteCreate) {
    const country = this.payerCountry(input.payerCountry);
    if (!methodOffered(input.paymentMethod, country)) throw PaymentErrors.methodUnavailable();
    if (!this.registry.hasActiveProvider()) throw PaymentErrors.providerUnavailable();
    const booking = await this.database.client.booking.findFirst({
      where: {
        reference: this.bookingReference(rawReference),
        customerIdentityId: customerIdentityOf(actor),
      },
      select: { id: true, tripId: true },
    });
    if (!booking) throw BookingErrors.notFound();

    const quote = await this.database.client.$transaction((tx) =>
      this.createInTransaction(tx, {
        actor,
        bookingId: booking.id,
        tripId: booking.tripId,
        country,
        method: input.paymentMethod,
      }),
    );
    return customerQuoteView(quote);
  }

  private async createInTransaction(
    tx: DatabaseTransaction,
    input: {
      actor: CustomerActor;
      bookingId: string;
      tripId: string;
      country: PayerCountry;
      method: PaymentQuoteCreate['paymentMethod'];
    },
  ): Promise<PaymentQuoteRow> {
    // Lock order of every payment path: trip (shared) -> booking.
    const [trip] = await tx.$queryRaw<Array<{ status: string; planned_departure_at: Date | null }>>`
      SELECT "status"::text AS "status", "planned_departure_at"
      FROM "trip" WHERE "id" = ${input.tripId}::uuid
      FOR SHARE
    `;
    const [booking] = await tx.$queryRaw<LockedBooking[]>`
      SELECT "id", "reference", "cancelled_at", "confirmed_at", "hold_expires_at",
        "unit_amount_minor", "currency_code", "currency_minor_unit"
      FROM "booking"
      WHERE "id" = ${input.bookingId}::uuid
        AND "customer_identity_id" = ${customerIdentityOf(input.actor)}::uuid
      FOR UPDATE
    `;
    if (!booking) throw BookingErrors.notFound();
    const now = await databaseNow(tx);
    if (booking.cancelled_at) throw PaymentErrors.bookingNotPayable();
    if (booking.confirmed_at) throw PaymentErrors.bookingConfirmed();
    if (booking.hold_expires_at.getTime() <= now.getTime()) throw PaymentErrors.bookingExpired();
    if (
      trip?.status !== 'SCHEDULED' ||
      !trip.planned_departure_at ||
      trip.planned_departure_at.getTime() <= now.getTime()
    ) {
      throw PaymentErrors.bookingNotPayable();
    }
    // Serialized by the booking lock: the bound is exact.
    const quotes = await tx.paymentQuote.count({ where: { bookingId: booking.id } });
    if (quotes >= MAX_QUOTES_PER_BOOKING) throw PaymentErrors.quoteLimitReached();

    const seatCount = await tx.bookingSeat.count({ where: { bookingId: booking.id } });
    const amountMinor = bookingAmountMinor(booking.unit_amount_minor, seatCount);
    const presentment = PRESENTMENT_CURRENCIES[input.country];
    const conversion = this.fx.convert({
      amountMinor,
      fromCurrency: booking.currency_code,
      fromMinorUnit: booking.currency_minor_unit,
      toCurrency: presentment.code,
      toMinorUnit: presentment.minorUnit,
    });
    if (!conversion) throw PaymentErrors.fxUnavailable();
    // Routed on the exact amount and the remaining hold, from the locked rows.
    const route = this.registry.route({
      method: input.method,
      payerCountry: input.country,
      currencyCode: presentment.code,
      presentmentAmountMinor: conversion.presentmentAmountMinor,
      holdRemainingSeconds: holdRemaining(booking.hold_expires_at, now),
    });
    if (!route) throw PaymentErrors.methodUnavailable();

    const quote = await tx.paymentQuote.create({
      data: {
        bookingId: booking.id,
        bookingAmountMinor: amountMinor,
        bookingCurrencyCode: booking.currency_code,
        bookingCurrencyMinorUnit: booking.currency_minor_unit,
        presentmentAmountMinor: conversion.presentmentAmountMinor,
        presentmentCurrencyCode: presentment.code,
        presentmentCurrencyMinorUnit: presentment.minorUnit,
        fxRate: conversion.rate,
        fxSource: conversion.source,
        quotedAt: now,
        expiresAt: quoteExpiry(now, booking.hold_expires_at),
        payerCountry: input.country,
        paymentMethod: input.method,
        providerCandidate: route.provider.name,
      },
      select: paymentQuoteSelect,
    });
    await this.audit.record(
      {
        actor: input.actor,
        action: 'PAYMENT_QUOTE_CREATED',
        resourceType: 'payment_quote',
        resourceId: quote.id,
        after: {
          bookingReference: booking.reference,
          paymentMethod: quote.paymentMethod,
          payerCountry: quote.payerCountry,
          bookingAmountMinor: amountToNumber(quote.bookingAmountMinor),
          bookingCurrencyCode: quote.bookingCurrencyCode,
          presentmentAmountMinor: amountToNumber(quote.presentmentAmountMinor),
          presentmentCurrencyCode: quote.presentmentCurrencyCode,
          fxRate: quote.fxRate.toFixed(),
          fxSource: quote.fxSource,
          expiresAt: quote.expiresAt,
        },
      },
      tx,
    );
    return quote;
  }

  private payerCountry(raw: string): PayerCountry {
    const country = raw.trim().toUpperCase();
    if (!isPayerCountry(country)) throw PaymentErrors.countryUnsupported();
    return country;
  }

  /** A booking reference; someone else's booking is indistinguishable from none. */
  private bookingReference(raw: string): string {
    const reference = normalizeBookingReference(raw);
    if (!reference) throw BookingErrors.notFound();
    return reference;
  }
}
