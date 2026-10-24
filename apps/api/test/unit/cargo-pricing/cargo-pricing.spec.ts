import { describe, expect, it } from 'vitest';
import {
  estimateCargo,
  estimateCargoWithRule,
  type CargoPricingEngineRule,
} from '../../../src/cargo-pricing/cargo-pricing.engine.js';
import {
  cargoEstimateSchema,
  cargoPricingVersionConfigSchema,
  type CargoEstimateInput,
} from '../../../src/cargo-pricing/cargo-pricing.dto.js';

const input = (overrides: Partial<CargoEstimateInput> = {}): CargoEstimateInput => ({
  from: 'PAR',
  to: 'DKR',
  weightKg: '25.000',
  category: 'STANDARD_PARCEL',
  pickup: false,
  delivery: false,
  fragile: false,
  ...overrides,
});

const rule = (overrides: Partial<CargoPricingEngineRule> = {}): CargoPricingEngineRule => ({
  code: 'SYNTHETIC_TEST_ONLY',
  version: 1,
  direction: 'PAR_DKR',
  method: 'ACTUAL_WEIGHT',
  currencyCode: 'EUR',
  currencyMinorUnit: 2,
  roundingMode: 'UP',
  unitPriceMinor: 300n,
  flatPriceMinor: null,
  minimumChargeMinor: null,
  volumetricDivisorCm3PerKg: null,
  quoteAboveWeightGrams: null,
  quoteAboveVolumeCm3: null,
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  effectiveTo: null,
  categories: ['STANDARD_PARCEL'],
  tiers: [],
  options: [],
  ...overrides,
});

describe('cargo pricing public contract', () => {
  it('accepts exact positive weights and strict, bounded dimensions', () => {
    expect(cargoEstimateSchema.safeParse(input()).success).toBe(true);
    for (const weightKg of ['0', '-1', '1.0001', 'NaN', '']) {
      expect(cargoEstimateSchema.safeParse({ ...input(), weightKg }).success, weightKg).toBe(false);
    }
    for (const lengthCm of [0, -1, 1.5, 1001]) {
      expect(
        cargoEstimateSchema.safeParse({
          ...input(),
          dimensions: { lengthCm, widthCm: 40, heightCm: 40 },
        }).success,
        String(lengthCm),
      ).toBe(false);
    }
    expect(cargoEstimateSchema.safeParse({ ...input(), to: 'PAR' }).success).toBe(false);
    expect(
      cargoEstimateSchema.safeParse({
        ...input(),
        dimensions: { lengthCm: 60, widthCm: 40, heightCm: 40 },
        volumeLiters: '96.000',
      }).success,
    ).toBe(false);
  });

  it('keeps the version configuration strict and rejects client-supplied formulas', () => {
    const version = {
      method: 'ACTUAL_WEIGHT',
      currencyCode: 'EUR',
      currencyMinorUnit: 2,
      roundingMode: 'UP',
      unitPriceMinor: '300',
      flatPriceMinor: null,
      minimumChargeMinor: null,
      volumetricDivisorCm3PerKg: null,
      quoteAboveWeightKg: null,
      quoteAboveVolumeLiters: null,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      categories: ['STANDARD_PARCEL'],
      tiers: [],
      options: [],
    };
    expect(cargoPricingVersionConfigSchema.safeParse(version).success).toBe(true);
    expect(
      cargoPricingVersionConfigSchema.safeParse({ ...version, formula: 'weight * 3' }).success,
    ).toBe(false);
  });
});

describe('exact cargo pricing engine (all figures are synthetic test data)', () => {
  it('calculates actual weight in integer minor units and is deterministic', () => {
    const first = estimateCargoWithRule(input(), rule());
    const second = estimateCargoWithRule(input(), rule());
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      requiresQuote: false,
      totalMinor: '7500',
      pricingVersion: 'SYNTHETIC_TEST_ONLY:v1',
      calculation: {
        method: 'ACTUAL_WEIGHT',
        actualWeightKg: '25.000',
        billableWeightKg: '25.000',
        unitPriceMinor: '300',
        baseAmountMinor: '7500',
      },
    });
  });

  it('applies an explicit minimum as a separate explainable line', () => {
    const result = estimateCargoWithRule(
      input({ weightKg: '1.000' }),
      rule({ minimumChargeMinor: 1000n }),
    );
    expect(result.totalMinor).toBe('1000');
    expect(result.calculation?.minimumApplied).toBe(true);
    expect(result.lines).toEqual([
      { kind: 'BASE', code: 'BASE', amountMinor: '300' },
      { kind: 'MINIMUM_ADJUSTMENT', code: 'MINIMUM_CHARGE', amountMinor: '700' },
    ]);
  });

  it('uses max(actual, volumetric) only with an explicit divisor', () => {
    const result = estimateCargoWithRule(
      input({
        weightKg: '10.000',
        dimensions: { lengthCm: 60, widthCm: 40, heightCm: 40 },
      }),
      rule({ method: 'VOLUMETRIC_WEIGHT', volumetricDivisorCm3PerKg: 5000 }),
    );
    expect(result).toMatchObject({
      volumeM3: '0.096000',
      totalMinor: '5760',
      calculation: {
        volumetricWeightKg: '19.200',
        billableWeightKg: '19.200',
      },
    });
    expect(
      estimateCargoWithRule(
        input({ weightKg: '10.000' }),
        rule({ method: 'VOLUMETRIC_WEIGHT', volumetricDivisorCm3PerKg: 5000 }),
      ),
    ).toMatchObject({ requiresQuote: true, quoteReason: 'VOLUME_REQUIRED' });
  });

  it('supports explicit volume and flat-rate methods', () => {
    expect(
      estimateCargoWithRule(
        input({ volumeLiters: '500.000' }),
        rule({ method: 'VOLUME', unitPriceMinor: 10_000n }),
      ).totalMinor,
    ).toBe('5000');
    expect(
      estimateCargoWithRule(
        input(),
        rule({
          method: 'FLAT_RATE',
          roundingMode: null,
          unitPriceMinor: null,
          flatPriceMinor: 4200n,
        }),
      ).totalMinor,
    ).toBe('4200');
  });

  it('selects contiguous tier boundaries exactly and fails closed on the quote tier', () => {
    const tiered = rule({
      method: 'TIERED_WEIGHT',
      unitPriceMinor: null,
      tiers: [
        {
          position: 0,
          minWeightGrams: 0n,
          maxWeightGrams: 10_000n,
          method: 'FLAT_RATE',
          unitPriceMinor: null,
          flatPriceMinor: 1000n,
          minimumChargeMinor: null,
        },
        {
          position: 1,
          minWeightGrams: 10_000n,
          maxWeightGrams: 20_000n,
          method: 'UNIT_WEIGHT',
          unitPriceMinor: 200n,
          flatPriceMinor: null,
          minimumChargeMinor: null,
        },
        {
          position: 2,
          minWeightGrams: 20_000n,
          maxWeightGrams: null,
          method: 'CUSTOM_QUOTE',
          unitPriceMinor: null,
          flatPriceMinor: null,
          minimumChargeMinor: null,
        },
      ],
    });
    expect(estimateCargoWithRule(input({ weightKg: '9.999' }), tiered).totalMinor).toBe('1000');
    expect(estimateCargoWithRule(input({ weightKg: '10.000' }), tiered)).toMatchObject({
      totalMinor: '2000',
      calculation: { tierPosition: 1 },
    });
    expect(estimateCargoWithRule(input({ weightKg: '19.999' }), tiered).totalMinor).toBe('4000');
    expect(estimateCargoWithRule(input({ weightKg: '20.000' }), tiered)).toMatchObject({
      requiresQuote: true,
      quoteReason: 'CUSTOM_QUOTE',
    });
  });

  it('handles the reverse direction, thresholds, options and missing rules fail-closed', () => {
    const reverseInput = input({ from: 'DKR', to: 'PAR', weightKg: '5.000' });
    expect(estimateCargoWithRule(reverseInput, rule({ direction: 'DKR_PAR' })).direction).toBe(
      'DKR_PAR',
    );
    expect(estimateCargoWithRule(input(), rule({ quoteAboveWeightGrams: 20_000n }))).toMatchObject({
      requiresQuote: true,
      quoteReason: 'THRESHOLD_EXCEEDED',
    });
    expect(estimateCargo(input(), [])).toMatchObject({
      requiresQuote: true,
      quoteReason: 'NO_ACTIVE_RULE',
      totalMinor: null,
    });
    expect(estimateCargo(input(), [rule(), rule({ code: 'OTHER' })])).toMatchObject({
      requiresQuote: true,
      quoteReason: 'AMBIGUOUS_RULE',
    });

    expect(estimateCargoWithRule(input({ pickup: true }), rule())).toMatchObject({
      requiresQuote: true,
      quoteReason: 'OPTION_NOT_CONFIGURED',
    });
    expect(
      estimateCargoWithRule(
        input({ pickup: true, delivery: true }),
        rule({
          options: [
            { kind: 'PICKUP', mode: 'INCLUDED', amountMinor: null },
            { kind: 'DELIVERY', mode: 'FLAT_RATE', amountMinor: 1500n },
          ],
        }),
      ),
    ).toMatchObject({
      requiresQuote: false,
      totalMinor: '9000',
      includedOptions: ['PICKUP'],
      lines: expect.arrayContaining([{ kind: 'OPTION', code: 'DELIVERY', amountMinor: '1500' }]),
    });
  });

  it('never emits a zero price from an incomplete or too-small configuration', () => {
    expect(
      estimateCargoWithRule(
        input({ weightKg: '0.001' }),
        rule({ roundingMode: 'DOWN', unitPriceMinor: 1n }),
      ),
    ).toMatchObject({
      requiresQuote: true,
      quoteReason: 'INCOMPLETE_RULE',
      totalMinor: null,
    });
  });
});
