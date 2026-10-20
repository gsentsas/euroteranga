import type {
  CardNetworkCode,
  CreatePaymentResult,
  PayerCountryCode,
  PaymentOption,
  PaymentQuote,
} from './auth-client.js';
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

const CARD_NETWORK_LABELS: Readonly<Record<CardNetworkCode, string>> = {
  CB: 'CB',
  VISA: 'Visa',
  MASTERCARD: 'Mastercard',
  AMEX: 'American Express',
};

/**
 * PAY-EU-1: what the payer is told about a card option, from the server's
 * answer only. Accepted networks are badges (the card itself, or the payer on
 * the provider's page for a co-badged card, decides the network); wallets are
 * a possibility on an eligible device, never a promise.
 */
export function describePaymentOption(
  option: Pick<PaymentOption, 'acceptedNetworks' | 'deviceWallets'>,
) {
  const wallets = option.deviceWallets.map((wallet) =>
    wallet === 'APPLE_PAY' ? 'Apple Pay' : 'Google Pay',
  );
  return {
    acceptedNetworks: option.acceptedNetworks.map((network) => CARD_NETWORK_LABELS[network]),
    deviceWalletsHint:
      wallets.length > 0
        ? `${wallets.join(' ou ')} peut aussi être proposé sur la page de paiement, selon votre appareil.`
        : null,
  };
}

/** Hosted payment pages the browser may be sent to (PAY-EU-1: Stripe Checkout only). */
const TRUSTED_CHECKOUT_ORIGINS = ['https://checkout.stripe.com'] as const;

/**
 * Where the browser goes to pay, if anywhere: only an https page of a trusted
 * provider origin, never any other URL. Leaving for it, or coming back from
 * it, confirms nothing: only the provider's signed event does.
 */
export function paymentRedirectTarget(checkout: CreatePaymentResult['checkout']): string | null {
  if (!checkout.redirectUrl) return null;
  let url: URL;
  try {
    url = new URL(checkout.redirectUrl);
  } catch {
    return null;
  }
  return (TRUSTED_CHECKOUT_ORIGINS as readonly string[]).includes(url.origin) &&
    url.username === '' &&
    url.password === ''
    ? url.toString()
    : null;
}
