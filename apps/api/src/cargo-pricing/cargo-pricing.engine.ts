import type { CargoEstimateInput } from './cargo-pricing.dto.js';

export type CargoPricingQuoteReason =
  | 'NO_ACTIVE_RULE'
  | 'AMBIGUOUS_RULE'
  | 'CUSTOM_QUOTE'
  | 'THRESHOLD_EXCEEDED'
  | 'VOLUME_REQUIRED'
  | 'NO_MATCHING_TIER'
  | 'OPTION_NOT_CONFIGURED'
  | 'OPTION_REQUIRES_QUOTE'
  | 'INCOMPLETE_RULE';

type CargoPricingDirection = 'PAR_DKR' | 'DKR_PAR';
type CargoPricingMethod =
  'ACTUAL_WEIGHT' | 'VOLUMETRIC_WEIGHT' | 'VOLUME' | 'FLAT_RATE' | 'TIERED_WEIGHT' | 'CUSTOM_QUOTE';
type CargoPricingRoundingMode = 'UP' | 'HALF_UP' | 'DOWN';
type CargoPricingOptionKind =
  'PICKUP' | 'DELIVERY' | 'FRAGILE_HANDLING' | 'PROFESSIONAL_HANDLING' | 'INSURANCE';

export interface CargoPricingEngineTier {
  position: number;
  minWeightGrams: bigint;
  maxWeightGrams: bigint | null;
  method: 'UNIT_WEIGHT' | 'UNIT_VOLUME' | 'FLAT_RATE' | 'CUSTOM_QUOTE';
  unitPriceMinor: bigint | null;
  flatPriceMinor: bigint | null;
  minimumChargeMinor: bigint | null;
}

export interface CargoPricingEngineOption {
  kind: CargoPricingOptionKind;
  mode: 'INCLUDED' | 'FLAT_RATE' | 'CUSTOM_QUOTE';
  amountMinor: bigint | null;
}

export interface CargoPricingEngineRule {
  code: string;
  version: number;
  direction: CargoPricingDirection;
  method: CargoPricingMethod;
  currencyCode: string;
  currencyMinorUnit: number;
  roundingMode: CargoPricingRoundingMode | null;
  unitPriceMinor: bigint | null;
  flatPriceMinor: bigint | null;
  minimumChargeMinor: bigint | null;
  volumetricDivisorCm3PerKg: number | null;
  quoteAboveWeightGrams: bigint | null;
  quoteAboveVolumeCm3: bigint | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  categories: readonly string[];
  tiers: readonly CargoPricingEngineTier[];
  options: readonly CargoPricingEngineOption[];
}

export interface CargoPricingEstimateLine {
  kind: 'BASE' | 'MINIMUM_ADJUSTMENT' | 'OPTION';
  code: string;
  amountMinor: string;
}

export interface CargoPricingEstimateResult {
  direction: CargoPricingDirection;
  from: 'PAR' | 'DKR';
  to: 'PAR' | 'DKR';
  category: string;
  actualWeightKg: string;
  volumeM3: string | null;
  requiresQuote: boolean;
  quoteReason: CargoPricingQuoteReason | null;
  currencyCode: string | null;
  currencyMinorUnit: number | null;
  totalMinor: string | null;
  pricingVersion: string | null;
  effectiveFrom: string | null;
  calculation: {
    method: CargoPricingMethod;
    actualWeightKg: string;
    volumetricWeightKg: string | null;
    billableWeightKg: string | null;
    volumeM3: string | null;
    unitPriceMinor: string | null;
    baseAmountMinor: string;
    minimumApplied: boolean;
    tierPosition: number | null;
  } | null;
  lines: CargoPricingEstimateLine[];
  includedOptions: CargoPricingOptionKind[];
}

const MAX_MONEY_MINOR = 999_999_999_999_999_999n;

/** Exact decimal with at most three places to thousandths (kg -> grams, L -> cm³). */
export function decimalToThousandths(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
}

function fixed(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0');
  return `${whole.toString()}.${fraction}`;
}

function roundRatio(
  numerator: bigint,
  denominator: bigint,
  mode: CargoPricingRoundingMode,
): bigint {
  if (denominator <= 0n || numerator < 0n) throw new Error('invalid exact ratio');
  if (mode === 'DOWN') return numerator / denominator;
  if (mode === 'UP') return (numerator + denominator - 1n) / denominator;
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function directionOf(input: CargoEstimateInput): CargoPricingDirection {
  return input.from === 'PAR' ? 'PAR_DKR' : 'DKR_PAR';
}

function volumeCm3Of(input: CargoEstimateInput): bigint | null {
  if (input.dimensions) {
    return (
      BigInt(input.dimensions.lengthCm) *
      BigInt(input.dimensions.widthCm) *
      BigInt(input.dimensions.heightCm)
    );
  }
  return input.volumeLiters ? decimalToThousandths(input.volumeLiters) : null;
}

function quoteResult(
  input: CargoEstimateInput,
  reason: CargoPricingQuoteReason,
  rule?: CargoPricingEngineRule,
): CargoPricingEstimateResult {
  const volumeCm3 = volumeCm3Of(input);
  return {
    direction: directionOf(input),
    from: input.from,
    to: input.to,
    category: input.category,
    actualWeightKg: fixed(decimalToThousandths(input.weightKg), 3),
    volumeM3: volumeCm3 === null ? null : fixed(volumeCm3, 6),
    requiresQuote: true,
    quoteReason: reason,
    currencyCode: rule?.currencyCode ?? null,
    currencyMinorUnit: rule?.currencyMinorUnit ?? null,
    totalMinor: null,
    pricingVersion: rule ? `${rule.code}:v${rule.version}` : null,
    effectiveFrom: rule?.effectiveFrom.toISOString() ?? null,
    calculation: null,
    lines: [],
    includedOptions: [],
  };
}

function requestedOptions(input: CargoEstimateInput): CargoPricingOptionKind[] {
  return [
    ...(input.pickup ? (['PICKUP'] as const) : []),
    ...(input.delivery ? (['DELIVERY'] as const) : []),
    ...(input.fragile ? (['FRAGILE_HANDLING'] as const) : []),
  ];
}

/** Calculate with one explicit version (also used by the protected OPS preview). */
export function estimateCargoWithRule(
  input: CargoEstimateInput,
  rule: CargoPricingEngineRule,
): CargoPricingEstimateResult {
  const actualWeightGrams = decimalToThousandths(input.weightKg);
  const volumeCm3 = volumeCm3Of(input);

  if (
    (rule.quoteAboveWeightGrams !== null && actualWeightGrams > rule.quoteAboveWeightGrams) ||
    (rule.quoteAboveVolumeCm3 !== null &&
      volumeCm3 !== null &&
      volumeCm3 > rule.quoteAboveVolumeCm3)
  ) {
    return quoteResult(input, 'THRESHOLD_EXCEEDED', rule);
  }
  if (rule.quoteAboveVolumeCm3 !== null && volumeCm3 === null) {
    return quoteResult(input, 'VOLUME_REQUIRED', rule);
  }
  if (rule.method === 'CUSTOM_QUOTE') return quoteResult(input, 'CUSTOM_QUOTE', rule);

  let volumetricWeightGrams: bigint | null = null;
  let billableWeightGrams: bigint | null = null;
  let unitPriceMinor: bigint | null = rule.unitPriceMinor;
  let baseAmountMinor: bigint | null = null;
  let tierPosition: number | null = null;
  let tierMinimum: bigint | null = null;

  if (rule.method === 'ACTUAL_WEIGHT') {
    billableWeightGrams = actualWeightGrams;
    if (rule.unitPriceMinor !== null && rule.roundingMode) {
      baseAmountMinor = roundRatio(
        actualWeightGrams * rule.unitPriceMinor,
        1000n,
        rule.roundingMode,
      );
    }
  } else if (rule.method === 'VOLUMETRIC_WEIGHT') {
    if (volumeCm3 === null) return quoteResult(input, 'VOLUME_REQUIRED', rule);
    if (
      rule.volumetricDivisorCm3PerKg !== null &&
      rule.unitPriceMinor !== null &&
      rule.roundingMode
    ) {
      volumetricWeightGrams =
        (volumeCm3 * 1000n + BigInt(rule.volumetricDivisorCm3PerKg) - 1n) /
        BigInt(rule.volumetricDivisorCm3PerKg);
      billableWeightGrams =
        actualWeightGrams > volumetricWeightGrams ? actualWeightGrams : volumetricWeightGrams;
      baseAmountMinor = roundRatio(
        billableWeightGrams * rule.unitPriceMinor,
        1000n,
        rule.roundingMode,
      );
    }
  } else if (rule.method === 'VOLUME') {
    if (volumeCm3 === null) return quoteResult(input, 'VOLUME_REQUIRED', rule);
    if (rule.unitPriceMinor !== null && rule.roundingMode) {
      baseAmountMinor = roundRatio(volumeCm3 * rule.unitPriceMinor, 1_000_000n, rule.roundingMode);
    }
  } else if (rule.method === 'FLAT_RATE') {
    baseAmountMinor = rule.flatPriceMinor;
  } else {
    if (rule.volumetricDivisorCm3PerKg !== null) {
      if (volumeCm3 === null) return quoteResult(input, 'VOLUME_REQUIRED', rule);
      volumetricWeightGrams =
        (volumeCm3 * 1000n + BigInt(rule.volumetricDivisorCm3PerKg) - 1n) /
        BigInt(rule.volumetricDivisorCm3PerKg);
    }
    billableWeightGrams =
      volumetricWeightGrams !== null && volumetricWeightGrams > actualWeightGrams
        ? volumetricWeightGrams
        : actualWeightGrams;
    const tier = rule.tiers.find(
      (candidate) =>
        billableWeightGrams !== null &&
        billableWeightGrams >= candidate.minWeightGrams &&
        (candidate.maxWeightGrams === null || billableWeightGrams < candidate.maxWeightGrams),
    );
    if (!tier) return quoteResult(input, 'NO_MATCHING_TIER', rule);
    if (tier.method === 'CUSTOM_QUOTE') return quoteResult(input, 'CUSTOM_QUOTE', rule);
    tierPosition = tier.position;
    tierMinimum = tier.minimumChargeMinor;
    unitPriceMinor = tier.unitPriceMinor;
    if (tier.method === 'FLAT_RATE') {
      baseAmountMinor = tier.flatPriceMinor;
    } else if (tier.method === 'UNIT_WEIGHT' && tier.unitPriceMinor !== null && rule.roundingMode) {
      baseAmountMinor = roundRatio(
        billableWeightGrams * tier.unitPriceMinor,
        1000n,
        rule.roundingMode,
      );
    } else if (tier.method === 'UNIT_VOLUME') {
      if (volumeCm3 === null) return quoteResult(input, 'VOLUME_REQUIRED', rule);
      if (tier.unitPriceMinor !== null && rule.roundingMode) {
        baseAmountMinor = roundRatio(
          volumeCm3 * tier.unitPriceMinor,
          1_000_000n,
          rule.roundingMode,
        );
      }
    }
  }

  if (baseAmountMinor === null || baseAmountMinor <= 0n || baseAmountMinor > MAX_MONEY_MINOR) {
    return quoteResult(input, 'INCOMPLETE_RULE', rule);
  }

  const minimum = [rule.minimumChargeMinor, tierMinimum]
    .filter((value): value is bigint => value !== null)
    .reduce<bigint | null>(
      (highest, value) => (highest === null || value > highest ? value : highest),
      null,
    );
  const chargedBase = minimum !== null && minimum > baseAmountMinor ? minimum : baseAmountMinor;
  const lines: CargoPricingEstimateLine[] = [
    { kind: 'BASE', code: 'BASE', amountMinor: baseAmountMinor.toString() },
  ];
  if (chargedBase > baseAmountMinor) {
    lines.push({
      kind: 'MINIMUM_ADJUSTMENT',
      code: 'MINIMUM_CHARGE',
      amountMinor: (chargedBase - baseAmountMinor).toString(),
    });
  }

  let totalMinor = chargedBase;
  const includedOptions: CargoPricingOptionKind[] = [];
  for (const requested of requestedOptions(input)) {
    const option = rule.options.find((candidate) => candidate.kind === requested);
    if (!option) return quoteResult(input, 'OPTION_NOT_CONFIGURED', rule);
    if (option.mode === 'CUSTOM_QUOTE') {
      return quoteResult(input, 'OPTION_REQUIRES_QUOTE', rule);
    }
    if (option.mode === 'INCLUDED') {
      includedOptions.push(requested);
      continue;
    }
    if (option.amountMinor === null || option.amountMinor <= 0n) {
      return quoteResult(input, 'INCOMPLETE_RULE', rule);
    }
    totalMinor += option.amountMinor;
    lines.push({ kind: 'OPTION', code: requested, amountMinor: option.amountMinor.toString() });
  }
  if (totalMinor > MAX_MONEY_MINOR) return quoteResult(input, 'INCOMPLETE_RULE', rule);

  return {
    direction: rule.direction,
    from: input.from,
    to: input.to,
    category: input.category,
    actualWeightKg: fixed(actualWeightGrams, 3),
    volumeM3: volumeCm3 === null ? null : fixed(volumeCm3, 6),
    requiresQuote: false,
    quoteReason: null,
    currencyCode: rule.currencyCode,
    currencyMinorUnit: rule.currencyMinorUnit,
    totalMinor: totalMinor.toString(),
    pricingVersion: `${rule.code}:v${rule.version}`,
    effectiveFrom: rule.effectiveFrom.toISOString(),
    calculation: {
      method: rule.method,
      actualWeightKg: fixed(actualWeightGrams, 3),
      volumetricWeightKg: volumetricWeightGrams === null ? null : fixed(volumetricWeightGrams, 3),
      billableWeightKg: billableWeightGrams === null ? null : fixed(billableWeightGrams, 3),
      volumeM3: volumeCm3 === null ? null : fixed(volumeCm3, 6),
      unitPriceMinor: unitPriceMinor?.toString() ?? null,
      baseAmountMinor: baseAmountMinor.toString(),
      minimumApplied: chargedBase > baseAmountMinor,
      tierPosition,
    },
    lines,
    includedOptions,
  };
}

/** Select exactly one eligible PUBLIC version; zero or ambiguity both fail closed. */
export function estimateCargo(
  input: CargoEstimateInput,
  rules: readonly CargoPricingEngineRule[],
): CargoPricingEstimateResult {
  if (rules.length === 0) return quoteResult(input, 'NO_ACTIVE_RULE');
  if (rules.length !== 1) return quoteResult(input, 'AMBIGUOUS_RULE');
  return estimateCargoWithRule(input, rules[0]!);
}
