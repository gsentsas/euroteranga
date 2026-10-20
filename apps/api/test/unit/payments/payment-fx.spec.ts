import { describe, expect, it } from 'vitest';
import {
  convertMinor,
  FX_RATE_SCALE,
  PaymentFxService,
  SyntheticCiFxRateSource,
} from '../../../src/payments/payment-fx.service.js';

const eur = (amountMinor: bigint) => ({
  amountMinor,
  fromCurrency: 'EUR',
  fromMinorUnit: 2,
});
const to = (code: 'EUR' | 'XOF' | 'MAD' | 'MRU') => ({
  toCurrency: code,
  toMinorUnit: code === 'XOF' ? 0 : 2,
});

describe('payment FX (PAY-HUB-1)', () => {
  const ci = new PaymentFxService(new SyntheticCiFxRateSource());
  const deployed = new PaymentFxService(null);

  it('keeps a same-currency amount as it is (identity, no rate source needed)', () => {
    for (const fx of [ci, deployed]) {
      expect(fx.convert({ ...eur(24_900n), ...to('EUR') })).toEqual({
        rate: '1',
        source: 'FX_IDENTITY',
        presentmentAmountMinor: 24_900n,
      });
    }
  });

  it('converts EUR to XOF, MAD and MRU exactly with the synthetic CI rates', () => {
    expect(ci.convert({ ...eur(24_900n), ...to('XOF') })).toEqual({
      rate: '655.957',
      source: 'FX_SYNTHETIC_CI',
      // 249.00 EUR x 655.957 = 163 333.293 XOF (no minor unit), rounded half up.
      presentmentAmountMinor: 163_333n,
    });
    expect(ci.convert({ ...eur(24_900n), ...to('MAD') })).toEqual({
      rate: '10.8',
      source: 'FX_SYNTHETIC_CI',
      presentmentAmountMinor: 268_920n,
    });
    expect(ci.convert({ ...eur(24_900n), ...to('MRU') })).toEqual({
      rate: '43',
      source: 'FX_SYNTHETIC_CI',
      presentmentAmountMinor: 1_070_700n,
    });
  });

  it('rounds half up to the presentment minor unit, deterministically', () => {
    // 0.01 EUR = 6.55957 XOF -> 7; 0.50 EUR = 327.9785 -> 328; 0.10 EUR = 65.5957 -> 66.
    expect(ci.convert({ ...eur(1n), ...to('XOF') })?.presentmentAmountMinor).toBe(7n);
    expect(ci.convert({ ...eur(50n), ...to('XOF') })?.presentmentAmountMinor).toBe(328n);
    expect(ci.convert({ ...eur(10n), ...to('XOF') })?.presentmentAmountMinor).toBe(66n);
    // An exact half goes up: 1 x 0.5 x 10^0 = 0.5 -> 1.
    expect(convertMinor({ amountMinor: 1n, fromMinorUnit: 0, toMinorUnit: 0, rate: '0.5' })).toBe(
      1n,
    );
    expect(convertMinor({ amountMinor: 3n, fromMinorUnit: 0, toMinorUnit: 0, rate: '0.5' })).toBe(
      2n,
    );
    // XOF (0 decimals) to EUR (2 decimals): 163 333 XOF -> 249.00 EUR at the inverse rate.
    const back = ci.convert({
      amountMinor: 163_333n,
      fromCurrency: 'XOF',
      fromMinorUnit: 0,
      ...to('EUR'),
    });
    expect(back?.rate).toBe('0.001524490172');
    expect(back?.presentmentAmountMinor).toBe(24_900n);
    // The same input always gives the same output.
    const once = ci.convert({ ...eur(123_456_789n), ...to('MRU') });
    expect(ci.convert({ ...eur(123_456_789n), ...to('MRU') })).toEqual(once);
  });

  it('stores rates with at most 12 decimals and never uses JavaScript floats', () => {
    const rate = new SyntheticCiFxRateSource().rate('MAD', 'XOF');
    expect(rate).toBe('60.736759259259');
    expect(rate.split('.')[1]!.length).toBeLessThanOrEqual(FX_RATE_SCALE);
    // Beyond Number.MAX_SAFE_INTEGER: still exact.
    const huge = 9_007_199_254_740_993n;
    expect(convertMinor({ amountMinor: huge, fromMinorUnit: 2, toMinorUnit: 2, rate: '1' })).toBe(
      huge,
    );
    expect(convertMinor({ amountMinor: huge, fromMinorUnit: 2, toMinorUnit: 2, rate: '43' })).toBe(
      huge * 43n,
    );
  });

  it('refuses invalid amounts, unsupported currencies and mismatched minor units', () => {
    expect(ci.convert({ ...eur(0n), ...to('XOF') })).toBeNull();
    expect(ci.convert({ ...eur(-5n), ...to('XOF') })).toBeNull();
    expect(ci.convert({ ...eur(100n), toCurrency: 'USD', toMinorUnit: 2 })).toBeNull();
    expect(
      ci.convert({ amountMinor: 100n, fromCurrency: 'GBP', fromMinorUnit: 2, ...to('XOF') }),
    ).toBeNull();
    expect(ci.convert({ ...eur(100n), toCurrency: 'EUR', toMinorUnit: 0 })).toBeNull();
  });

  it('has no rate in deployed environments: any real conversion is unavailable', () => {
    for (const code of ['XOF', 'MAD', 'MRU'] as const) {
      expect(deployed.convert({ ...eur(24_900n), ...to(code) }), code).toBeNull();
    }
  });
});
