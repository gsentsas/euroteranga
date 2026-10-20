import { describe, expect, it } from 'vitest';
import { describePaymentOption, paymentRedirectTarget } from './payment-display.js';

describe('describePaymentOption (PAY-EU-1)', () => {
  it('names the accepted card networks, from the server answer only', () => {
    expect(
      describePaymentOption({
        acceptedNetworks: ['CB', 'VISA', 'MASTERCARD', 'AMEX'],
        deviceWallets: ['APPLE_PAY', 'GOOGLE_PAY'],
      }),
    ).toEqual({
      acceptedNetworks: ['CB', 'Visa', 'Mastercard', 'American Express'],
      deviceWalletsHint:
        'Apple Pay ou Google Pay peut aussi être proposé sur la page de paiement, selon votre appareil.',
    });
  });

  it('promises nothing when the server lists no network or wallet', () => {
    expect(describePaymentOption({ acceptedNetworks: [], deviceWallets: [] })).toEqual({
      acceptedNetworks: [],
      deviceWalletsHint: null,
    });
  });
});

describe('paymentRedirectTarget (PAY-EU-1)', () => {
  const checkout = (redirectUrl: string | null) =>
    ({ provider: 'STRIPE', testMode: true, redirectUrl }) as const;

  it('follows a Stripe Checkout page only', () => {
    expect(paymentRedirectTarget(checkout('https://checkout.stripe.com/c/pay/cs_test_a1'))).toBe(
      'https://checkout.stripe.com/c/pay/cs_test_a1',
    );
    expect(paymentRedirectTarget(checkout(null))).toBeNull();
  });

  it.each([
    'http://checkout.stripe.com/c/pay/cs_test_a1',
    'https://checkout.stripe.com.example.test/c/pay',
    'https://evil.example.test/?next=https://checkout.stripe.com/',
    'https://user:pass@checkout.stripe.com/c/pay',
    'javascript:alert(1)',
    '//checkout.stripe.com/c/pay',
    'not a url',
  ])('never follows %s', (url) => {
    expect(paymentRedirectTarget(checkout(url))).toBeNull();
  });
});
