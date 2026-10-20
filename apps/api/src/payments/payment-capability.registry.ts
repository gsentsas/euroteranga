import { Inject, Injectable } from '@nestjs/common';
import {
  PAYMENT_METHOD_CODES,
  PAYMENT_PROVIDER_CODES,
  PAYER_COUNTRIES,
  type PayerCountry,
  type PaymentMethodCode,
  type PaymentProviderCode,
} from './payment-catalog.js';
import {
  PAYMENT_PROVIDERS,
  type PaymentProvider,
  type ProviderCapability,
} from './providers/payment-provider.js';

type Declaration = ProviderCapability & { implemented: boolean };

const capability = (
  providerCode: PaymentProviderCode,
  input: {
    methods: readonly PaymentMethodCode[];
    countries: readonly PayerCountry[];
    currencies: readonly string[];
    priority: number;
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
  supportedCurrencies: input.currencies,
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

const CARDS = ['CARD', 'CARD_CB', 'CARD_VISA', 'CARD_MASTERCARD', 'CARD_AMEX'] as const;
const WALLETS = ['APPLE_PAY', 'GOOGLE_PAY'] as const;
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

/**
 * Declared future reach of every provider in the programme. Only SANDBOX has
 * an adapter in PAY-HUB-1, and it is test-only; all real declarations stay
 * implemented=false, configured=false and live=false until their own PR and
 * merchant onboarding. Declaring a provider here never makes it routable:
 * only an injected adapter is.
 */
export const PROVIDER_CAPABILITY_DECLARATIONS: readonly Declaration[] = [
  capability('SANDBOX', {
    methods: PAYMENT_METHOD_CODES,
    countries: PAYER_COUNTRIES,
    currencies: ['EUR', 'XOF', 'MAD', 'MRU'],
    priority: 10_000,
    refunds: 'FULL_AND_PARTIAL',
    partialRefunds: true,
    implemented: true,
    testMode: true,
    redirect: false,
  }),
  capability('STRIPE', {
    methods: [
      ...CARDS,
      ...WALLETS,
      'SEPA_CREDIT_TRANSFER',
      'SEPA_DIRECT_DEBIT',
      'BIZUM',
      'WERO',
      'KLARNA',
      'ALMA',
    ],
    countries: ['FR', 'ES', 'MA', 'MR', 'SN'],
    currencies: ['EUR', 'XOF', 'MAD', 'MRU'],
    priority: 10,
    merchantCountries: ['FR', 'ES'],
    refunds: 'FULL_AND_PARTIAL',
    partialRefunds: true,
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
    methods: ['CMI_CARD', 'CARD_VISA', 'CARD_MASTERCARD', 'MAROCPAY'],
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
  /** Tried first when it can still collect this method (the quote's candidate). */
  preferredProvider?: PaymentProviderCode;
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
      .filter((provider) => {
        const item = provider.capability;
        return (
          item.active &&
          item.supportedMethods.includes(input.method) &&
          item.payerCountries.includes(input.payerCountry) &&
          item.supportedCurrencies.includes(input.currencyCode)
        );
      })
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
        supportedCurrencies: declaration.supportedCurrencies,
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
        configured: Boolean(adapter),
        live: Boolean(adapter?.capability.active && !adapter.testMode),
      };
    });
  }
}
