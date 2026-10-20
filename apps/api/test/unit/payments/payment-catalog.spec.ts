import { describe, expect, it } from 'vitest';
import {
  CURRENCY_MINOR_UNITS,
  isPayerCountry,
  isPaymentMethod,
  methodGroup,
  methodOffered,
  methodSettlement,
  methodsForCountry,
  PAYER_COUNTRIES,
  PAYMENT_METHOD_BY_CODE,
  PAYMENT_METHOD_CODES,
  PAYMENT_METHODS,
  PAYMENT_PROVIDER_CODES,
  PRESENTMENT_CURRENCIES,
  PRESENTMENT_CURRENCY_CODES,
} from '../../../src/payments/payment-catalog.js';

const NETWORK_CODES: readonly string[] = ['CARD_CB', 'CARD_VISA', 'CARD_MASTERCARD', 'CARD_AMEX'];

describe('payment catalogue (PAY-HUB-1)', () => {
  it('lists every method once, with a label; only card network codes are never offered', () => {
    expect(PAYMENT_METHOD_CODES).toHaveLength(31);
    expect(new Set(PAYMENT_METHOD_CODES).size).toBe(PAYMENT_METHOD_CODES.length);
    expect(PAYMENT_METHODS.map((method) => method.code)).toEqual([...PAYMENT_METHOD_CODES]);
    for (const method of PAYMENT_METHODS) {
      expect(method.label.trim(), method.code).not.toBe('');
      expect(method.countries.length > 0, method.code).toBe(!NETWORK_CODES.includes(method.code));
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
    expect(codes('FR')).toEqual(expect.arrayContaining(['CARD', 'WERO', 'ALMA']));
    expect(methodGroup(PAYMENT_METHOD_BY_CODE.get('CARD')!, 'FR')).toBe('RECOMMENDED');

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

describe('payment catalogue (PAY-EU-1)', () => {
  it('offers one card choice in every country; networks are badges, never choices', () => {
    for (const country of PAYER_COUNTRIES) {
      expect(methodOffered('CARD', country), country).toBe(true);
      for (const network of NETWORK_CODES) {
        expect(methodOffered(network as 'CARD_CB', country), `${network} ${country}`).toBe(false);
        expect(methodsForCountry(country).map((method) => method.code)).not.toContain(network);
      }
    }
    // Still part of the vocabulary: earlier attempts keep their method.
    for (const network of NETWORK_CODES) expect(isPaymentMethod(network)).toBe(true);
  });

  it('keeps Bizum to Spain, Wero to France, Alma and Klarna to France and Spain', () => {
    expect(PAYMENT_METHOD_BY_CODE.get('BIZUM')!.countries).toEqual(['ES']);
    expect(methodOffered('BIZUM', 'FR')).toBe(false);
    expect(PAYMENT_METHOD_BY_CODE.get('WERO')!.countries).toEqual(['FR']);
    expect(methodOffered('WERO', 'ES')).toBe(false);
    expect(PAYMENT_METHOD_BY_CODE.get('ALMA')!.countries).toEqual(['FR', 'ES']);
    expect(PAYMENT_METHOD_BY_CODE.get('KLARNA')!.countries).toEqual(['FR', 'ES']);
  });

  it('classifies when each method is confirmed: days-long ones need a booking policy', () => {
    const settlement = Object.fromEntries(
      PAYMENT_METHOD_CODES.map((code) => [code, methodSettlement(code)]),
    );
    for (const code of ['CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'BIZUM', 'WERO', 'KLARNA', 'ALMA']) {
      expect(settlement[code], code).toBe('INSTANT');
    }
    for (const code of [
      'SEPA_DIRECT_DEBIT',
      'SEPA_CREDIT_TRANSFER',
      'BANK_TRANSFER',
      'CASH_AT_AGENCY',
      'MOROCCO_CASH_AGENCY',
    ]) {
      expect(settlement[code], code).toBe('ASYNC_LONG');
    }
    expect(settlement.WAVE_SN).toBe('ASYNC_SHORT');
    expect(() => methodSettlement('UNKNOWN' as 'CARD')).toThrow(/unknown payment method/);
  });
});
