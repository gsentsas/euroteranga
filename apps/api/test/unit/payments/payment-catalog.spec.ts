import { describe, expect, it } from 'vitest';
import {
  CURRENCY_MINOR_UNITS,
  isPayerCountry,
  isPaymentMethod,
  methodGroup,
  methodOffered,
  methodsForCountry,
  PAYER_COUNTRIES,
  PAYMENT_METHOD_BY_CODE,
  PAYMENT_METHOD_CODES,
  PAYMENT_METHODS,
  PAYMENT_PROVIDER_CODES,
  PRESENTMENT_CURRENCIES,
  PRESENTMENT_CURRENCY_CODES,
} from '../../../src/payments/payment-catalog.js';

describe('payment catalogue (PAY-HUB-1)', () => {
  it('lists every customer-facing method once, with a label and at least one country', () => {
    expect(PAYMENT_METHOD_CODES).toHaveLength(31);
    expect(new Set(PAYMENT_METHOD_CODES).size).toBe(PAYMENT_METHOD_CODES.length);
    expect(PAYMENT_METHODS.map((method) => method.code)).toEqual([...PAYMENT_METHOD_CODES]);
    for (const method of PAYMENT_METHODS) {
      expect(method.label.trim(), method.code).not.toBe('');
      expect(method.countries.length, method.code).toBeGreaterThan(0);
      for (const country of method.recommendedCountries) {
        expect(method.countries, method.code).toContain(country);
      }
    }
  });

  it('keeps methods (what the customer chooses) apart from providers (who collects)', () => {
    expect(PAYMENT_PROVIDER_CODES).toEqual([
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
    ]);
    // Wave is a method; WAVE, PAYDUNYA or PAYTECH are providers that may collect it.
    expect(isPaymentMethod('WAVE_SN')).toBe(true);
    expect(isPaymentMethod('WAVE')).toBe(false);
    expect(isPaymentMethod('PAYDUNYA')).toBe(false);
    expect(isPaymentMethod('SANDBOX')).toBe(false);
    // A provider code is never a customer label.
    for (const method of PAYMENT_METHODS) {
      expect(PAYMENT_PROVIDER_CODES as readonly string[]).not.toContain(method.label);
    }
  });

  it('offers each corridor country its own methods, the local ones recommended', () => {
    expect([...PAYER_COUNTRIES]).toEqual(['FR', 'ES', 'MA', 'MR', 'SN']);
    const codes = (country: (typeof PAYER_COUNTRIES)[number]) =>
      methodsForCountry(country).map((method) => method.code);
    expect(codes('SN')).toEqual(
      expect.arrayContaining(['WAVE_SN', 'ORANGE_MONEY_SN', 'FREE_MONEY_SN', 'CASH_AT_AGENCY']),
    );
    expect(codes('SN')).not.toContain('BIZUM');
    expect(codes('MR')).toEqual(expect.arrayContaining(['BANKILY_MR', 'MASRVI_MR', 'SEDAD_MR']));
    expect(codes('MA')).toEqual(expect.arrayContaining(['CMI_CARD', 'MAROCPAY']));
    expect(codes('ES')).toContain('BIZUM');
    expect(codes('FR')).toEqual(expect.arrayContaining(['CARD_CB', 'WERO', 'ALMA']));

    const wave = PAYMENT_METHOD_BY_CODE.get('WAVE_SN')!;
    expect(methodGroup(wave, 'SN')).toBe('RECOMMENDED');
    expect(methodGroup(PAYMENT_METHOD_BY_CODE.get('FREE_MONEY_SN')!, 'SN')).toBe('MOBILE_MONEY');
    expect(methodOffered('WAVE_SN', 'SN')).toBe(true);
    expect(methodOffered('WAVE_SN', 'FR')).toBe(false);
    expect(methodOffered('BANKILY_MR', 'SN')).toBe(false);
  });

  it('charges each payer country in its currency, with ISO 4217 minor units', () => {
    expect([...PRESENTMENT_CURRENCY_CODES]).toEqual(['EUR', 'XOF', 'MAD', 'MRU']);
    expect(CURRENCY_MINOR_UNITS).toEqual({ EUR: 2, XOF: 0, MAD: 2, MRU: 2 });
    const currencies = Object.fromEntries(
      PAYER_COUNTRIES.map((country) => [country, PRESENTMENT_CURRENCIES[country].code]),
    );
    expect(currencies).toEqual({ FR: 'EUR', ES: 'EUR', MA: 'MAD', MR: 'MRU', SN: 'XOF' });
    for (const country of PAYER_COUNTRIES) {
      const currency = PRESENTMENT_CURRENCIES[country];
      expect(currency.minorUnit, country).toBe(CURRENCY_MINOR_UNITS[currency.code]);
    }
    expect(isPayerCountry('SN')).toBe(true);
    expect(isPayerCountry('DE')).toBe(false);
    expect(isPayerCountry('sn')).toBe(false);
  });
});
