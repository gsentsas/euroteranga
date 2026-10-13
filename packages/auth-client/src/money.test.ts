import { describe, expect, it } from 'vitest';
import { formatMoney, minorToDecimalString, parseMoneyToMinor } from './money.js';

/** Intl uses (narrow) non-breaking spaces; compare with plain spaces. */
const plain = (value: string) => value.replace(/[\u00a0\u202f]/g, ' ');

describe('exact money helpers', () => {
  it('formats minor units exactly in fr-FR', () => {
    expect(plain(formatMoney(12550, 'EUR', 2))).toBe('125,50 EUR');
    expect(plain(formatMoney(12345, 'EUR', 2))).toBe('123,45 EUR');
    expect(plain(formatMoney(15000, 'XOF', 0))).toBe('15 000 XOF');
    expect(plain(formatMoney(5, 'EUR', 2))).toBe('0,05 EUR');
    expect(plain(formatMoney(1234567, 'TND', 3))).toBe('1 234,567 TND');
    // A synthetic code is accepted: there is no fixed ISO list.
    expect(plain(formatMoney(100, 'ZZZ', 2))).toBe('1,00 ZZZ');
  });

  it('keeps large amounts exact (no float rounding)', () => {
    expect(minorToDecimalString(2_147_483_647, 2)).toBe('21474836.47');
    expect(plain(formatMoney(2_147_483_647, 'EUR', 2))).toBe('21 474 836,47 EUR');
    expect(minorToDecimalString(1, 3)).toBe('0.001');
    expect(minorToDecimalString(15000, 0)).toBe('15000');
  });

  it('parses user input to minor units without rounding', () => {
    expect(parseMoneyToMinor('125,50', 2)).toBe(12550);
    expect(parseMoneyToMinor('125.5', 2)).toBe(12550);
    expect(parseMoneyToMinor('123,45', 2)).toBe(12345);
    expect(parseMoneyToMinor('15 000', 0)).toBe(15000);
    expect(parseMoneyToMinor('15\u202f000', 0)).toBe(15000);
    expect(parseMoneyToMinor('0,10', 2)).toBe(10);
    // 0.1 + 0.2 style traps do not exist: the conversion is decimal-exact.
    expect(parseMoneyToMinor('0,29', 2)).toBe(29);
    expect(parseMoneyToMinor('1,005', 3)).toBe(1005);
  });

  it.each([
    ['too many decimals', '125,505', 2],
    ['decimals for a zero-decimal currency', '15000,5', 0],
    ['zero', '0', 2],
    ['a negative amount', '-5', 2],
    ['letters', '12a', 2],
    ['two separators', '1.234,50', 2],
    ['scientific notation', '1e3', 2],
    ['empty', '', 2],
    ['over the API maximum', '21474837', 2],
  ])('refuses %s', (_label, input, minorUnit) => {
    expect(parseMoneyToMinor(input, minorUnit)).toBeNull();
  });

  it('refuses an invalid minor unit', () => {
    expect(() => formatMoney(100, 'EUR', 4)).toThrow(RangeError);
    expect(() => parseMoneyToMinor('1', -1)).toThrow(RangeError);
    expect(() => formatMoney(1.5, 'EUR', 2)).toThrow(RangeError);
  });
});
