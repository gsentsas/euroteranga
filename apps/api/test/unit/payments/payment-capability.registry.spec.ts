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

const wave = { method: 'WAVE_SN', payerCountry: 'SN', currencyCode: 'XOF' } as const;

describe('payment capability registry (PAY-HUB-1)', () => {
  it('declares every provider once; only SANDBOX has an adapter, and it is test-only', () => {
    expect(PROVIDER_CAPABILITY_DECLARATIONS.map((item) => item.providerCode)).toEqual([
      ...PAYMENT_PROVIDER_CODES,
    ]);
    expect(
      PROVIDER_CAPABILITY_DECLARATIONS.filter((item) => item.implemented).map(
        (item) => item.providerCode,
      ),
    ).toEqual(['SANDBOX']);
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
    const stripe = registry.capabilities().find((item) => item.providerCode === 'STRIPE')!;
    expect(stripe).toMatchObject({ implemented: false, configured: false, live: false });
  });

  it('prefers the lowest priority, the quote candidate first, with a stable tie-break', () => {
    const direct = syntheticProvider('WAVE', { supportedMethods: ['WAVE_SN'], priority: 10 });
    const paydunya = syntheticProvider('PAYDUNYA', {
      supportedMethods: ['WAVE_SN', 'ORANGE_MONEY_SN'],
      priority: 30,
    });
    const paytech = syntheticProvider('PAYTECH', {
      supportedMethods: ['WAVE_SN', 'ORANGE_MONEY_SN'],
      priority: 30,
    });
    const registry = new PaymentCapabilityRegistry([paytech, paydunya, direct]);
    expect(registry.candidates(wave).map((route) => route.provider.name)).toEqual([
      'WAVE',
      'PAYDUNYA',
      'PAYTECH',
    ]);
    expect(registry.route({ ...wave, preferredProvider: 'PAYTECH' })?.provider.name).toBe(
      'PAYTECH',
    );
    expect(() => new PaymentCapabilityRegistry([direct, direct])).toThrow(/configured twice/);
  });

  it('falls back to another provider of the same method, never to another method', () => {
    const direct = syntheticProvider('WAVE', {
      supportedMethods: ['WAVE_SN'],
      priority: 10,
      active: false,
    });
    const aggregator = syntheticProvider('PAYDUNYA', {
      supportedMethods: ['WAVE_SN'],
      priority: 30,
    });
    const cards = syntheticProvider('STRIPE', {
      supportedMethods: ['CARD', 'CARD_VISA'],
      priority: 1,
    });
    // Wave direct is down: the aggregator collecting Wave takes over.
    const withAggregator = new PaymentCapabilityRegistry([direct, aggregator, cards]);
    expect(withAggregator.route({ ...wave, preferredProvider: 'WAVE' })?.provider.name).toBe(
      'PAYDUNYA',
    );
    // Nobody collects Wave: unavailable, even though a card provider is active.
    const cardsOnly = new PaymentCapabilityRegistry([direct, cards]);
    expect(cardsOnly.hasActiveProvider()).toBe(true);
    expect(cardsOnly.route(wave)).toBeNull();
    expect(cardsOnly.candidates(wave)).toEqual([]);
    expect(
      cardsOnly.route({ method: 'CARD', payerCountry: 'SN', currencyCode: 'XOF' })?.provider.name,
    ).toBe('STRIPE');
  });

  it('routes only within the declared countries and currencies', () => {
    const aggregator = syntheticProvider('PAYDUNYA', { supportedMethods: ['WAVE_SN'] });
    const registry = new PaymentCapabilityRegistry([aggregator]);
    expect(registry.route(wave)?.provider.name).toBe('PAYDUNYA');
    expect(registry.route({ ...wave, payerCountry: 'FR' })).toBeNull();
    expect(registry.route({ ...wave, currencyCode: 'EUR' })).toBeNull();
    expect(registry.route({ ...wave, method: 'BANKILY_MR' })).toBeNull();
  });
});
