import { describe, expect, it } from 'vitest';
import type { PaymentProviderCode } from './auth-client.js';
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
  const checkout = (redirectUrl: string | null, provider: PaymentProviderCode = 'STRIPE') =>
    ({ provider, testMode: true, redirectUrl }) as const;

  it('follows a Stripe Checkout page only', () => {
    expect(paymentRedirectTarget(checkout('https://checkout.stripe.com/c/pay/cs_test_a1'))).toBe(
      'https://checkout.stripe.com/c/pay/cs_test_a1',
    );
    expect(paymentRedirectTarget(checkout(null))).toBeNull();
  });

  it('follows PayPal approval pages only (PAY-PAYPAL-1)', () => {
    for (const host of ['www.paypal.com', 'www.sandbox.paypal.com']) {
      expect(
        paymentRedirectTarget(
          checkout(`https://${host}/checkoutnow?token=5O190127TN364715T`, 'PAYPAL'),
        ),
      ).toBe(`https://${host}/checkoutnow?token=5O190127TN364715T`);
    }
    for (const url of [
      'https://www.paypal.com/signin',
      'https://paypal.com/checkoutnow?token=5O190127TN364715T',
      'https://www.paypal.com.example.test/checkoutnow?token=5O190127TN364715T',
      'http://www.paypal.com/checkoutnow?token=5O190127TN364715T',
      'https://user:pass@www.paypal.com/checkoutnow?token=5O190127TN364715T',
    ]) {
      expect(paymentRedirectTarget(checkout(url, 'PAYPAL')), url).toBeNull();
    }
  });

  it('opens only the documented Wave launch URL in a normal browser', () => {
    const id = 'cos-18qq25rgr100a';
    expect(
      paymentRedirectTarget(checkout(`https://pay.wave.com/c/${id}?a=24900&c=XOF`, 'WAVE')),
    ).toBe(`https://pay.wave.com/c/${id}?a=24900&c=XOF`);
    for (const url of [
      `http://pay.wave.com/c/${id}`,
      `https://pay.wave.com.evil.test/c/${id}`,
      `https://pay.wave.com/other/${id}`,
      'https://pay.wave.com/c/not-a-session',
      `https://user:pass@pay.wave.com/c/${id}`,
    ]) {
      expect(paymentRedirectTarget(checkout(url, 'WAVE')), url).toBeNull();
    }
    // A trusted URL never crosses provider boundaries.
    expect(paymentRedirectTarget(checkout(`https://pay.wave.com/c/${id}`, 'STRIPE'))).toBeNull();
    expect(
      paymentRedirectTarget(checkout('https://checkout.stripe.com/c/pay/cs_test_a1', 'WAVE')),
    ).toBeNull();
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
