import { describe, expect, it } from 'vitest';
import {
  CARGO_QUOTE_REFERENCE_PATTERN,
  cargoQuoteTotal,
  exactCargoQuoteAmount,
  generateCargoQuoteReference,
  normalizeCargoQuoteReference,
  withFreshCargoQuoteReference,
} from '../../../src/cargo/cargo-quote-rules.js';

describe('cargo quote references and exact money', () => {
  it('creates opaque ETCQ references and normalizes them', () => {
    const reference = generateCargoQuoteReference(() => 31);
    expect(reference).toBe('ETCQ-ZZZZZZZZZZZZ');
    expect(reference).toMatch(CARGO_QUOTE_REFERENCE_PATTERN);
    expect(normalizeCargoQuoteReference(' etcq-0123456789ab ')).toBe('ETCQ-0123456789AB');
    expect(normalizeCargoQuoteReference('ETCQ-ILOU01234567')).toBeNull();
  });

  it('keeps money exact with bigint and never accepts zero or decimal strings', () => {
    expect(exactCargoQuoteAmount('1')).toBe(1n);
    expect(exactCargoQuoteAmount('999999999999999999')).toBe(999999999999999999n);
    for (const invalid of ['0', '-1', '1.5', '1e2', '1000000000000000000']) {
      expect(() => exactCargoQuoteAmount(invalid)).toThrow('INVALID_CARGO_QUOTE_AMOUNT');
    }
  });

  it('derives charges minus discounts exactly and rejects a negative total', () => {
    expect(
      cargoQuoteTotal([
        { kind: 'CHARGE', amountMinor: '9007199254740993' },
        { kind: 'CHARGE', amountMinor: '7' },
        { kind: 'DISCOUNT', amountMinor: '10' },
      ]),
    ).toBe(9007199254740990n);

    expect(() =>
      cargoQuoteTotal([
        { kind: 'CHARGE', amountMinor: '100' },
        { kind: 'DISCOUNT', amountMinor: '101' },
      ]),
    ).toThrow('NEGATIVE_CARGO_QUOTE_TOTAL');
  });

  it('retries only reference collisions', async () => {
    const generated = ['ETCQ-000000000000', 'ETCQ-111111111111'];
    let calls = 0;
    const result = await withFreshCargoQuoteReference(
      async (reference) => {
        calls += 1;
        if (calls === 1) throw new Error('collision');
        return reference;
      },
      (error) => String(error).includes('collision'),
      () => generated.shift()!,
    );
    expect(result).toBe('ETCQ-111111111111');

    await expect(
      withFreshCargoQuoteReference(
        async () => {
          throw new Error('database unavailable');
        },
        () => false,
      ),
    ).rejects.toThrow('database unavailable');
  });
});
