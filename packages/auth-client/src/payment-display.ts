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

/**
 * Hosted payment pages the browser may be sent to: Stripe Checkout (PAY-EU-1)
 * and PayPal's approval page (PAY-PAYPAL-1, live and sandbox).
 */
const TRUSTED_CHECKOUT_PAGES: ReadonlyArray<{ origin: string; pathname?: string }> = [
  { origin: 'https://checkout.stripe.com' },
  { origin: 'https://www.paypal.com', pathname: '/checkoutnow' },
  { origin: 'https://www.sandbox.paypal.com', pathname: '/checkoutnow' },
];

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
  if (url.username !== '' || url.password !== '') return null;
  const trusted = TRUSTED_CHECKOUT_PAGES.some(
    (page) =>
      page.origin === url.origin && (page.pathname === undefined || page.pathname === url.pathname),
  );
  return trusted ? url.toString() : null;
}
