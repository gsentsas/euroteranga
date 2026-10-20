import type { PayerCountryCode, PaymentQuote } from './auth-client.js';
import { formatMoney } from './money.js';

/** PAY-HUB-1: the payer countries of the corridor, as listed to customers. */
export const PAYER_COUNTRY_OPTIONS: ReadonlyArray<{ code: PayerCountryCode; label: string }> = [
  { code: 'FR', label: 'France' },
  { code: 'ES', label: 'Espagne' },
  { code: 'MA', label: 'Maroc' },
  { code: 'MR', label: 'Mauritanie' },
  { code: 'SN', label: 'Sénégal' },
];

/**
 * What the payer is shown before confirming a quote, from the server's exact
 * amounts: the amount in their currency, the booking total when the currency
 * differs, and the end of validity.
 */
export function describePaymentQuote(quote: PaymentQuote, locale = 'fr-FR') {
  const { presentment, booking } = quote;
  return {
    amount: formatMoney(
      presentment.amountMinor,
      presentment.currencyCode,
      presentment.currencyMinorUnit,
      locale,
    ),
    bookingAmount:
      presentment.currencyCode === booking.currencyCode
        ? null
        : formatMoney(booking.amountMinor, booking.currencyCode, booking.currencyMinorUnit, locale),
    validUntil: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
      new Date(quote.expiresAt),
    ),
  };
}
