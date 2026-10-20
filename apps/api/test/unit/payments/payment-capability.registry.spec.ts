import { describe, expect, it } from 'vitest';
import {
  declaredCapability,
  PaymentCapabilityRegistry,
  PROVIDER_CAPABILITY_DECLARATIONS,
} from '../../../src/payments/payment-capability.registry.js';
import {
  PAYMENT_METHOD_CODES,
  PAYMENT_PROVIDER_CODES,
  type PaymentMethodCode,
  type PaymentProviderCode,
} from '../../../src/payments/payment-catalog.js';
import type {
  PaymentProvider,
  ProviderCapability,
} from '../../../src/payments/providers/payment-provider.js';
import { SandboxPaymentProvider } from '../../../src/payments/providers/sandbox-payment.provider.js';

/** A synthetic adapter: no network, a capability chosen by the test. */
function syntheticProvider(
  name: PaymentProviderCode,
  capability: Partial<ProviderCapability> & { supportedMethods: readonly PaymentMethodCode[] },
): PaymentProvider {
  return {
    name,
    testMode: true,
    capability: {
      ...declaredCapability(name),
      payerCountries: ['SN'],
      supportedCurrencies: ['XOF'],
      ...capability,
    },
    createPayment: () => Promise.reject(new Error('not used')),
    verifyWebhook: () => {
      throw new Error('not used');
    },
    parseWebhook: () => {
      throw new Error('not used');
    },
  };
}

const wave = {
  method: 'WAVE_SN',
  payerCountry: 'SN',
  currencyCode: 'XOF',
  presentmentAmountMinor: 163_333n,
  holdRemainingSeconds: 2100,
} as const;

describe('payment capability registry (PAY-HUB-1)', () => {
  it('declares every provider once; SANDBOX, Stripe, PayPal and Wave have adapters', () => {
    expect(PROVIDER_CAPABILITY_DECLARATIONS.map((item) => item.providerCode)).toEqual([
      ...PAYMENT_PROVIDER_CODES,
    ]);
    expect(
      PROVIDER_CAPABILITY_DECLARATIONS.filter((item) => item.implemented).map(
        (item) => item.providerCode,
      ),
    ).toEqual(['SANDBOX', 'STRIPE', 'PAYPAL', 'WAVE']);
    expect(PROVIDER_CAPABILITY_DECLARATIONS.every((item) => item.active === false)).toBe(true);
    const sandbox = PROVIDER_CAPABILITY_DECLARATIONS.find(
      (item) => item.providerCode === 'SANDBOX',
    )!;
    expect(sandbox.testMode).toBe(true);
    expect(sandbox.supportedMethods).toEqual([...PAYMENT_METHOD_CODES]);
  });

  it('routes nothing when payments are disabled, and reports nothing configured or live', () => {
    const registry = new PaymentCapabilityRegistry([]);
    expect(registry.hasActiveProvider()).toBe(false);
    expect(registry.route(wave)).toBeNull();
    expect(registry.provider('SANDBOX')).toBeNull();
    const capabilities = registry.capabilities();
    expect(capabilities).toHaveLength(PAYMENT_PROVIDER_CODES.length);
    expect(capabilities.every((item) => item.supported && !item.configured && !item.live)).toBe(
      true,
    );
    // Internal routing never leaves the server through this view.
    expect(JSON.stringify(capabilities)).not.toMatch(/priority|secret|key/i);
  });

  it('shows SANDBOX as configured but never LIVE', () => {
    const registry = new PaymentCapabilityRegistry([
      new SandboxPaymentProvider(Buffer.alloc(32, 1)),
    ]);
    const sandbox = registry.capabilities().find((item) => item.providerCode === 'SANDBOX')!;
    expect(sandbox).toMatchObject({
      supported: true,
      implemented: true,
      configured: true,
      live: false,
      testMode: true,
    });
    // Implemented since PAY-EU-1, but not configured here, never live, and
    // no refund is ever sent to it by EURO TERANGA.
    const stripe = registry.capabilities().find((item) => item.providerCode === 'STRIPE')!;
    expect(stripe).toMatchObject({
      implemented: true,
      configured: false,
      live: false,
      refundExecutionImplemented: false,
    });
  });

  it('prefers the lowest priority, the quote candidate first, with a stable tie-break', () => {
    const direct = syntheticProvider('CMI', {
      supportedMethods: ['MAROCPAY'],
      payerCountries: ['MA'],
      supportedCurrencies: ['MAD'],
      priority: 10,
    });
    const second = syntheticProvider('CHARIPAY', {
      supportedMethods: ['MAROCPAY'],
      payerCountries: ['MA'],
      supportedCurrencies: ['MAD'],
      priority: 30,
    });
    const third = syntheticProvider('CASH', {
      supportedMethods: ['MAROCPAY'],
      payerCountries: ['MA'],
      supportedCurrencies: ['MAD'],
      priority: 30,
    });
    const marocPay = {
      ...wave,
      method: 'MAROCPAY' as const,
      payerCountry: 'MA' as const,
      currencyCode: 'MAD',
    };
    const registry = new PaymentCapabilityRegistry([third, second, direct]);
    expect(registry.candidates(marocPay).map((route) => route.provider.name)).toEqual([
      'CMI',
      'CASH',
      'CHARIPAY',
    ]);
    expect(registry.route({ ...marocPay, preferredProvider: 'CHARIPAY' })?.provider.name).toBe(
      'CHARIPAY',
    );
    expect(() => new PaymentCapabilityRegistry([direct, direct])).toThrow(/configured twice/);
  });

  it('falls back to another provider of the same method, never to another method', () => {
    const direct = syntheticProvider('CMI', {
      supportedMethods: ['MAROCPAY'],
      payerCountries: ['MA'],
      supportedCurrencies: ['MAD'],
      priority: 10,
      active: false,
    });
    const alternative = syntheticProvider('CHARIPAY', {
      supportedMethods: ['MAROCPAY'],
      payerCountries: ['MA'],
      supportedCurrencies: ['MAD'],
      priority: 30,
    });
    const cards = syntheticProvider('STRIPE', {
      supportedMethods: ['CARD'],
      payerCountries: ['MA'],
      supportedCurrencies: ['MAD'],
      minimumHoldRemainingSeconds: 0,
      priority: 1,
    });
    const marocPay = {
      ...wave,
      method: 'MAROCPAY' as const,
      payerCountry: 'MA' as const,
      currencyCode: 'MAD',
    };
    const withAlternative = new PaymentCapabilityRegistry([direct, alternative, cards]);
    expect(withAlternative.route({ ...marocPay, preferredProvider: 'CMI' })?.provider.name).toBe(
      'CHARIPAY',
    );
    // Nobody collects MarocPay: unavailable, even though a card provider is active.
    const cardsOnly = new PaymentCapabilityRegistry([direct, cards]);
    expect(cardsOnly.hasActiveProvider()).toBe(true);
    expect(cardsOnly.route(marocPay)).toBeNull();
    expect(cardsOnly.candidates(marocPay)).toEqual([]);
    expect(cardsOnly.route({ ...marocPay, method: 'CARD' })?.provider.name).toBe('STRIPE');
  });

  it('routes only within the declared countries and currencies', () => {
    const direct = syntheticProvider('WAVE', { supportedMethods: ['WAVE_SN'] });
    const registry = new PaymentCapabilityRegistry([direct]);
    expect(registry.route(wave)?.provider.name).toBe('WAVE');
    expect(registry.route({ ...wave, payerCountry: 'FR' })).toBeNull();
    expect(registry.route({ ...wave, currencyCode: 'EUR' })).toBeNull();
    expect(registry.route({ ...wave, method: 'BANKILY_MR' })).toBeNull();
  });
});
