import { Inject, Injectable } from '@nestjs/common';
import {
  methodSettlement,
  PAYMENT_METHOD_CODES,
  PAYMENT_PROVIDER_CODES,
  PAYER_COUNTRIES,
  type CardNetwork,
  type PayerCountry,
  type PaymentMethodCode,
  type PaymentProviderCode,
} from './payment-catalog.js';
import {
  PAYMENT_PROVIDERS,
  type PaymentProvider,
  type ProviderAmountLimit,
  type ProviderCapability,
  type ProviderExclusionReason,
} from './providers/payment-provider.js';

type Declaration = ProviderCapability & { implemented: boolean };

const capability = (
  providerCode: PaymentProviderCode,
  input: {
    methods: readonly PaymentMethodCode[];
    countries: readonly PayerCountry[];
    currencies: readonly string[];
    priority: number;
    methodCountries?: ProviderCapability['methodCountries'];
    amountLimits?: ProviderCapability['amountLimits'];
    cardNetworks?: ProviderCapability['cardNetworks'];
    deviceWallets?: ProviderCapability['deviceWallets'];
    collectionWindowSeconds?: number | null;
    minimumHoldRemainingSeconds?: number;
    excluded?: readonly { method: PaymentMethodCode; reason: ProviderExclusionReason }[];
    redirect?: boolean;
    phone?: boolean;
    merchantCountries?: readonly PayerCountry[];
    refunds?: 'NONE' | 'FULL' | 'FULL_AND_PARTIAL';
    partialRefunds?: boolean;
    implemented?: boolean;
    testMode?: boolean;
    instant?: boolean;
  },
): Declaration => ({
  providerCode,
  supportedMethods: input.methods,
  payerCountries: input.countries,
  methodCountries: input.methodCountries ?? {},
  supportedCurrencies: input.currencies,
  amountLimits: input.amountLimits ?? {},
  cardNetworks: input.cardNetworks ?? {},
  deviceWallets: input.deviceWallets ?? [],
  collectionWindowSeconds: input.collectionWindowSeconds ?? null,
  minimumHoldRemainingSeconds: input.minimumHoldRemainingSeconds ?? 0,
  excludedMethods: input.excluded ?? [],
  testMode: input.testMode ?? false,
  refundCapabilities: input.refunds ?? 'NONE',
  partialRefundCapabilities: input.partialRefunds ?? false,
  webhookCapabilities: ['SIGNED_EVENTS', 'REPLAY_PROTECTION', 'TIMESTAMP_CHECK'],
  instantConfirmation: input.instant ?? false,
  requiresRedirect: input.redirect ?? true,
  requiresPhone: input.phone ?? false,
  requiresMerchantEntityCountry: input.merchantCountries ?? [],
  priority: input.priority,
  active: false,
  implemented: input.implemented ?? false,
});

const SENEGAL_MOBILE = [
  'WAVE_SN',
  'ORANGE_MONEY_SN',
  'FREE_MONEY_SN',
  'EXPRESSO_SN',
  'WIZALL_SN',
  'DJAMO_SN',
] as const;
const MAURITANIA_MOBILE = [
  'BANKILY_MR',
  'MASRVI_MR',
  'SEDAD_MR',
  'BIMBANK_MR',
  'CLICK_MR',
  'BCI_PAY_MR',
] as const;

const EUROPEAN_CARD_NETWORKS = {
  FR: ['CB', 'VISA', 'MASTERCARD', 'AMEX'],
  ES: ['VISA', 'MASTERCARD', 'AMEX'],
} as const satisfies Partial<Record<PayerCountry, readonly CardNetwork[]>>;

const euros = (minMinor: number, maxMinor: number): ProviderAmountLimit => ({
  minMinor: BigInt(minMinor),
  maxMinor: BigInt(maxMinor),
});

/**
 * Stripe Checkout (PAY-EU-1). Its session can be paid for at least 30 minutes
 * (Stripe's minimum `expires_at`), plus one minute against clock skew; the
 * hold must outlast it by five more minutes, so Checkout always closes before
 * the seats are freed: an attempt starts only while 36 minutes of hold remain.
 * With the default 15-minute hold Stripe is therefore unavailable;
 * BOOKING_HOLD_TTL_SECONDS must be raised first (3600 s leaves the customer 24
 * minutes to start paying). See docs/payments/stripe-europe.md.
 */
export const STRIPE_COLLECTION_WINDOW_SECONDS = 31 * 60;
export const STRIPE_HOLD_MARGIN_SECONDS = 5 * 60;

/**
 * Declared reach of every provider in the programme. A declaration never
 * makes a provider routable: only an injected, active adapter is. SANDBOX is
 * test-only (local and CI). STRIPE is the first real adapter (PAY-EU-1):
 * implemented, but disabled by default and never live in the pilot; its
 * declaration is checked against Stripe's documentation (stripe-europe.md).
 * Every other real declaration remains a planning hypothesis.
 */
export const PROVIDER_CAPABILITY_DECLARATIONS: readonly Declaration[] = [
  capability('SANDBOX', {
    methods: PAYMENT_METHOD_CODES,
    countries: PAYER_COUNTRIES,
    currencies: ['EUR', 'XOF', 'MAD', 'MRU'],
    cardNetworks: {
      ...EUROPEAN_CARD_NETWORKS,
      MA: ['VISA', 'MASTERCARD'],
      MR: ['VISA', 'MASTERCARD'],
      SN: ['VISA', 'MASTERCARD'],
    },
    priority: 10_000,
    refunds: 'FULL_AND_PARTIAL',
    partialRefunds: true,
    implemented: true,
    testMode: true,
    redirect: false,
  }),
  capability('STRIPE', {
    // Each one restricted exactly with Checkout's allowed_payment_method_types.
    methods: ['CARD', 'BIZUM', 'KLARNA'],
    countries: ['FR', 'ES'],
    methodCountries: { BIZUM: ['ES'] },
    currencies: ['EUR'],
    // Stripe's minimum charge is 0.50 EUR; Bizum allows up to 5,000 EUR, and
    // Klarna's largest offer is 4,000 EUR in France and 10,000 EUR in Spain.
    amountLimits: {
      CARD: { FR: euros(50, 99_999_999), ES: euros(50, 99_999_999) },
      BIZUM: { ES: euros(50, 500_000) },
      KLARNA: { FR: euros(50, 400_000), ES: euros(50, 1_000_000) },
    },
    cardNetworks: EUROPEAN_CARD_NETWORKS,
    deviceWallets: ['APPLE_PAY', 'GOOGLE_PAY'],
    collectionWindowSeconds: STRIPE_COLLECTION_WINDOW_SECONDS,
    minimumHoldRemainingSeconds: STRIPE_COLLECTION_WINDOW_SECONDS + STRIPE_HOLD_MARGIN_SECONDS,
    excluded: [
      { method: 'APPLE_PAY', reason: 'NOT_SELECTABLE_IN_CHECKOUT' },
      { method: 'GOOGLE_PAY', reason: 'NOT_SELECTABLE_IN_CHECKOUT' },
      { method: 'SEPA_DIRECT_DEBIT', reason: 'ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY' },
      { method: 'SEPA_CREDIT_TRANSFER', reason: 'ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY' },
      { method: 'ALMA', reason: 'BUSINESS_CATEGORY_PROHIBITED' },
      { method: 'WERO', reason: 'NOT_SUPPORTED_BY_PINNED_SDK' },
      { method: 'PAYPAL', reason: 'SEPARATE_PROVIDER_PR' },
    ],
    priority: 10,
    merchantCountries: ['FR', 'ES'],
    refunds: 'FULL_AND_PARTIAL',
    partialRefunds: true,
    implemented: true,
    instant: true,
  }),
  capability('PAYPAL', {
    methods: ['PAYPAL'],
    countries: ['FR', 'ES', 'SN'],
    currencies: ['EUR', 'XOF'],
    priority: 20,
    refunds: 'FULL_AND_PARTIAL',
    partialRefunds: true,
  }),
  capability('PAYDUNYA', {
    methods: ['CARD', ...SENEGAL_MOBILE],
    countries: ['SN'],
    currencies: ['XOF'],
    priority: 30,
    phone: true,
    refunds: 'FULL',
  }),
  capability('PAYTECH', {
    methods: ['CARD', ...SENEGAL_MOBILE],
    countries: ['SN'],
    currencies: ['XOF'],
    priority: 40,
    phone: true,
    refunds: 'FULL',
  }),
  capability('WAVE', {
    methods: ['WAVE_SN'],
    countries: ['SN'],
    currencies: ['XOF'],
    priority: 10,
    phone: true,
    refunds: 'FULL',
  }),
  capability('ORANGE_MONEY', {
    methods: ['ORANGE_MONEY_SN'],
    countries: ['SN'],
    currencies: ['XOF'],
    priority: 10,
    phone: true,
    refunds: 'FULL',
  }),
  capability('CMI', {
    methods: ['CMI_CARD', 'CARD', 'MAROCPAY'],
    countries: ['MA'],
    currencies: ['MAD'],
    priority: 10,
    merchantCountries: ['MA'],
    refunds: 'FULL_AND_PARTIAL',
    partialRefunds: true,
  }),
  capability('CHARIPAY', {
    methods: ['MAROCPAY'],
    countries: ['MA'],
    currencies: ['MAD'],
    priority: 20,
    merchantCountries: ['MA'],
    refunds: 'FULL',
  }),
  capability('MOOSYL', {
    methods: MAURITANIA_MOBILE,
    countries: ['MR'],
    currencies: ['MRU'],
    priority: 10,
    phone: true,
    merchantCountries: ['MR'],
    refunds: 'FULL',
  }),
  capability('MANUAL_BANK_TRANSFER', {
    methods: ['BANK_TRANSFER'],
    countries: ['MA', 'MR', 'SN'],
    currencies: ['XOF', 'MAD', 'MRU'],
    priority: 100,
    redirect: false,
    instant: false,
  }),
  capability('CASH', {
    methods: ['MOROCCO_CASH_AGENCY', 'CASH_AT_AGENCY'],
    countries: ['MA', 'MR', 'SN'],
    currencies: ['XOF', 'MAD', 'MRU'],
    priority: 100,
    redirect: false,
    instant: false,
  }),
] as const;

if (
  new Set(PROVIDER_CAPABILITY_DECLARATIONS.map((item) => item.providerCode)).size !==
  PAYMENT_PROVIDER_CODES.length
) {
  throw new Error('every payment provider code needs exactly one capability declaration');
}

/** The declared capability of a provider, for its adapter (active once constructed). */
export function declaredCapability(code: PaymentProviderCode): ProviderCapability {
  const declaration = PROVIDER_CAPABILITY_DECLARATIONS.find((item) => item.providerCode === code);
  if (!declaration) throw new Error(`no capability declaration for ${code}`);
  const { implemented: _implemented, ...capability } = declaration;
  return { ...capability, active: true };
}

export interface PaymentRoute {
  provider: PaymentProvider;
  capability: ProviderCapability;
}

export interface PaymentRouteRequest {
  method: PaymentMethodCode;
  payerCountry: PayerCountry;
  currencyCode: string;
  /** What the payer will be asked for, in minor units of currencyCode. */
  presentmentAmountMinor: bigint;
  /** Hold time left now; a provider whose checkout could outlive it is skipped. */
  holdRemainingSeconds: number;
  /** Tried first when it can still collect this method (the quote's candidate). */
  preferredProvider?: PaymentProviderCode;
}

/** Whether a capability collects this request, all conditions together (fail closed). */
export function capabilityCollects(item: ProviderCapability, input: PaymentRouteRequest): boolean {
  const countries = item.methodCountries[input.method] ?? item.payerCountries;
  const limit = item.amountLimits[input.method]?.[input.payerCountry];
  return (
    item.active &&
    // A result days later cannot hold seats: such methods need a booking policy first.
    methodSettlement(input.method) !== 'ASYNC_LONG' &&
    item.supportedMethods.includes(input.method) &&
    item.payerCountries.includes(input.payerCountry) &&
    countries.includes(input.payerCountry) &&
    item.supportedCurrencies.includes(input.currencyCode) &&
    (!limit ||
      (input.presentmentAmountMinor >= limit.minMinor &&
        input.presentmentAmountMinor <= limit.maxMinor)) &&
    input.holdRemainingSeconds >= item.minimumHoldRemainingSeconds
  );
}

/**
 * Central, fail-closed router: it only returns injected, active adapters, and
 * only for the exact method the customer chose. A method nobody can collect
 * is unavailable: there is never a fallback to another method (a Wave
 * payment is never silently charged to a card), only to another provider of
 * the same method (Wave direct, then an aggregator offering Wave).
 */
@Injectable()
export class PaymentCapabilityRegistry {
  private readonly configured: ReadonlyMap<PaymentProviderCode, PaymentProvider>;

  constructor(@Inject(PAYMENT_PROVIDERS) providers: readonly PaymentProvider[]) {
    const configured = new Map<PaymentProviderCode, PaymentProvider>();
    for (const provider of providers) {
      if (configured.has(provider.name)) {
        throw new Error(`payment provider ${provider.name} is configured twice`);
      }
      configured.set(provider.name, provider);
    }
    this.configured = configured;
  }

  /** Whether any adapter can take a payment at all (false when DISABLED). */
  hasActiveProvider(): boolean {
    return [...this.configured.values()].some((provider) => provider.capability.active);
  }

  provider(code: PaymentProviderCode): PaymentProvider | null {
    const provider = this.configured.get(code);
    return provider?.capability.active ? provider : null;
  }

  /** Every active adapter able to collect this method, here, in this currency, best first. */
  candidates(input: PaymentRouteRequest): PaymentRoute[] {
    return [...this.configured.values()]
      .filter((provider) => capabilityCollects(provider.capability, input))
      .sort((left, right) => {
        if (left.name === input.preferredProvider) return -1;
        if (right.name === input.preferredProvider) return 1;
        return (
          left.capability.priority - right.capability.priority ||
          left.name.localeCompare(right.name)
        );
      })
      .map((provider) => ({ provider, capability: provider.capability }));
  }

  route(input: PaymentRouteRequest): PaymentRoute | null {
    return this.candidates(input)[0] ?? null;
  }

  /**
   * OPS and documentation view. Four distinct facts: SUPPORTED (declared in
   * the programme), IMPLEMENTED (an adapter exists in the code), CONFIGURED
   * (an adapter is wired in this environment) and LIVE (configured, active
   * and moving real money). Priorities and configuration stay internal.
   */
  capabilities() {
    return PROVIDER_CAPABILITY_DECLARATIONS.map((declaration) => {
      const adapter = this.configured.get(declaration.providerCode);
      return {
        providerCode: declaration.providerCode,
        supportedMethods: declaration.supportedMethods,
        payerCountries: declaration.payerCountries,
        methodCountries: declaration.methodCountries,
        supportedCurrencies: declaration.supportedCurrencies,
        cardNetworks: declaration.cardNetworks,
        excludedMethods: declaration.excludedMethods,
        testMode: adapter?.testMode ?? declaration.testMode,
        refundCapabilities: declaration.refundCapabilities,
        partialRefundCapabilities: declaration.partialRefundCapabilities,
        webhookCapabilities: declaration.webhookCapabilities,
        instantConfirmation: declaration.instantConfirmation,
        requiresRedirect: declaration.requiresRedirect,
        requiresPhone: declaration.requiresPhone,
        requiresMerchantEntityCountry: declaration.requiresMerchantEntityCountry,
        supported: true,
        implemented: declaration.implemented,
        // No adapter sends a refund to its provider yet (STRIPE included):
        // OPS refunds are recorded facts, executed outside EURO TERANGA.
        refundExecutionImplemented: false,
        configured: Boolean(adapter),
        live: Boolean(adapter?.capability.active && !adapter.testMode),
      };
    });
  }
}
