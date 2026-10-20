/** PAY-HUB-1: stable business vocabulary. Provider codes never become UX labels. */
export const PAYMENT_PROVIDER_CODES = [
  'SANDBOX',
  'STRIPE',
  'PAYPAL',
  'PAYDUNYA',
  'PAYTECH',
  'WAVE',
  'ORANGE_MONEY',
  'CMI',
  'CHARIPAY',
  'MOOSYL',
  'MANUAL_BANK_TRANSFER',
  'CASH',
] as const;

export type PaymentProviderCode = (typeof PAYMENT_PROVIDER_CODES)[number];

export const PAYMENT_METHOD_CODES = [
  'CARD',
  'CARD_CB',
  'CARD_VISA',
  'CARD_MASTERCARD',
  'CARD_AMEX',
  'APPLE_PAY',
  'GOOGLE_PAY',
  'PAYPAL',
  'SEPA_CREDIT_TRANSFER',
  'SEPA_DIRECT_DEBIT',
  'BIZUM',
  'WERO',
  'KLARNA',
  'ALMA',
  'WAVE_SN',
  'ORANGE_MONEY_SN',
  'FREE_MONEY_SN',
  'EXPRESSO_SN',
  'WIZALL_SN',
  'DJAMO_SN',
  'MAROCPAY',
  'CMI_CARD',
  'MOROCCO_CASH_AGENCY',
  'BANKILY_MR',
  'MASRVI_MR',
  'SEDAD_MR',
  'BIMBANK_MR',
  'CLICK_MR',
  'BCI_PAY_MR',
  'BANK_TRANSFER',
  'CASH_AT_AGENCY',
] as const;

export type PaymentMethodCode = (typeof PAYMENT_METHOD_CODES)[number];
export const PAYER_COUNTRIES = ['FR', 'ES', 'MA', 'MR', 'SN'] as const;
export type PayerCountry = (typeof PAYER_COUNTRIES)[number];
export type PaymentMethodGroup = 'RECOMMENDED' | 'MOBILE_MONEY' | 'CARD_WALLET' | 'BANK' | 'AGENCY';

export interface PaymentMethodDescriptor {
  code: PaymentMethodCode;
  label: string;
  group: Exclude<PaymentMethodGroup, 'RECOMMENDED'>;
  countries: readonly PayerCountry[];
  recommendedCountries: readonly PayerCountry[];
}

const method = (
  code: PaymentMethodCode,
  label: string,
  group: Exclude<PaymentMethodGroup, 'RECOMMENDED'>,
  countries: readonly PayerCountry[],
  recommendedCountries: readonly PayerCountry[] = [],
): PaymentMethodDescriptor => ({ code, label, group, countries, recommendedCountries });

/**
 * Logical methods offered by country. This catalogue says what EURO TERANGA
 * intends to support; availability still requires an implemented, configured
 * provider capability and an exact FX quote.
 */
export const PAYMENT_METHODS: readonly PaymentMethodDescriptor[] = [
  method('CARD', 'Carte bancaire', 'CARD_WALLET', ['SN']),
  method('CARD_CB', 'Carte CB', 'CARD_WALLET', ['FR'], ['FR']),
  method('CARD_VISA', 'Visa', 'CARD_WALLET', ['FR', 'ES', 'MA', 'MR']),
  method('CARD_MASTERCARD', 'Mastercard', 'CARD_WALLET', ['FR', 'ES', 'MA', 'MR']),
  method('CARD_AMEX', 'American Express', 'CARD_WALLET', ['FR', 'ES']),
  method('APPLE_PAY', 'Apple Pay', 'CARD_WALLET', ['FR', 'ES']),
  method('GOOGLE_PAY', 'Google Pay', 'CARD_WALLET', ['FR', 'ES']),
  method('PAYPAL', 'PayPal', 'CARD_WALLET', ['FR', 'ES', 'SN']),
  method('SEPA_CREDIT_TRANSFER', 'Virement SEPA', 'BANK', ['FR', 'ES']),
  method('SEPA_DIRECT_DEBIT', 'Prélèvement SEPA', 'BANK', ['FR', 'ES']),
  method('BIZUM', 'Bizum', 'BANK', ['FR', 'ES'], ['ES']),
  method('WERO', 'Wero', 'BANK', ['FR']),
  method('KLARNA', 'Klarna', 'CARD_WALLET', ['FR', 'ES']),
  method('ALMA', 'Alma', 'CARD_WALLET', ['FR']),
  method('WAVE_SN', 'Wave', 'MOBILE_MONEY', ['SN'], ['SN']),
  method('ORANGE_MONEY_SN', 'Orange Money', 'MOBILE_MONEY', ['SN']),
  method('FREE_MONEY_SN', 'Free Money', 'MOBILE_MONEY', ['SN']),
  method('EXPRESSO_SN', 'Expresso', 'MOBILE_MONEY', ['SN']),
  method('WIZALL_SN', 'Wizall', 'MOBILE_MONEY', ['SN']),
  method('DJAMO_SN', 'Djamo', 'MOBILE_MONEY', ['SN']),
  method('MAROCPAY', 'MarocPay', 'MOBILE_MONEY', ['MA']),
  method('CMI_CARD', 'Carte CMI', 'CARD_WALLET', ['MA'], ['MA']),
  method('MOROCCO_CASH_AGENCY', 'Paiement en agence', 'AGENCY', ['MA']),
  method('BANKILY_MR', 'Bankily', 'MOBILE_MONEY', ['MR'], ['MR']),
  method('MASRVI_MR', 'Masrvi', 'MOBILE_MONEY', ['MR']),
  method('SEDAD_MR', 'Sedad', 'MOBILE_MONEY', ['MR']),
  method('BIMBANK_MR', 'BimBank', 'MOBILE_MONEY', ['MR']),
  method('CLICK_MR', 'Click', 'MOBILE_MONEY', ['MR']),
  method('BCI_PAY_MR', 'BCI Pay', 'MOBILE_MONEY', ['MR']),
  method('BANK_TRANSFER', 'Virement bancaire', 'BANK', ['MA', 'MR', 'SN']),
  method('CASH_AT_AGENCY', 'Paiement en agence', 'AGENCY', ['MR', 'SN']),
] as const;

export const PAYMENT_METHOD_BY_CODE = new Map(
  PAYMENT_METHODS.map((descriptor) => [descriptor.code, descriptor]),
);

/** Presentment currencies of PAY-HUB-1 and their ISO 4217 minor units. */
export const PRESENTMENT_CURRENCY_CODES = ['EUR', 'XOF', 'MAD', 'MRU'] as const;
export type PresentmentCurrency = (typeof PRESENTMENT_CURRENCY_CODES)[number];
export const CURRENCY_MINOR_UNITS: Readonly<Record<PresentmentCurrency, number>> = {
  EUR: 2,
  XOF: 0,
  MAD: 2,
  MRU: 2,
};

/** The currency a payer of each country is charged in. */
export const PRESENTMENT_CURRENCIES = {
  FR: { code: 'EUR', minorUnit: 2, countryName: 'France' },
  ES: { code: 'EUR', minorUnit: 2, countryName: 'Espagne' },
  MA: { code: 'MAD', minorUnit: 2, countryName: 'Maroc' },
  MR: { code: 'MRU', minorUnit: 2, countryName: 'Mauritanie' },
  SN: { code: 'XOF', minorUnit: 0, countryName: 'Sénégal' },
} as const satisfies Record<
  PayerCountry,
  { code: PresentmentCurrency; minorUnit: number; countryName: string }
>;

export const isPayerCountry = (value: string): value is PayerCountry =>
  (PAYER_COUNTRIES as readonly string[]).includes(value);
export const isPaymentMethod = (value: string): value is PaymentMethodCode =>
  (PAYMENT_METHOD_CODES as readonly string[]).includes(value);
export const isPresentmentCurrency = (value: string): value is PresentmentCurrency =>
  (PRESENTMENT_CURRENCY_CODES as readonly string[]).includes(value);

export function methodsForCountry(country: PayerCountry): PaymentMethodDescriptor[] {
  return PAYMENT_METHODS.filter((descriptor) => descriptor.countries.includes(country));
}

/** A method the catalogue offers in this country (not yet "available": see the registry). */
export function methodOffered(method: PaymentMethodCode, country: PayerCountry): boolean {
  return PAYMENT_METHOD_BY_CODE.get(method)?.countries.includes(country) ?? false;
}

export function methodGroup(
  descriptor: PaymentMethodDescriptor,
  country: PayerCountry,
): PaymentMethodGroup {
  return descriptor.recommendedCountries.includes(country) ? 'RECOMMENDED' : descriptor.group;
}
