import { Prisma } from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { isPresentmentCurrency, type PresentmentCurrency } from './payment-catalog.js';

export type PaymentFxSource =
  'FX_IDENTITY' | 'FX_SYNTHETIC_CI' | 'FX_MANUAL_OPS' | 'FX_PROVIDER' | 'FX_EXTERNAL_SERVICE';

/**
 * Where conversion rates come from. PAY-HUB-1 only implements the synthetic
 * CI source; FX_MANUAL_OPS (rates entered and approved in OPS), FX_PROVIDER
 * (the rate the PSP applies) and FX_EXTERNAL_SERVICE (a market feed) are
 * declared for their own reviewed PRs.
 */
export interface FxRateSource {
  readonly source: Exclude<PaymentFxSource, 'FX_IDENTITY'>;
  /** Units of `to` for one unit of `from` (major units), as a decimal string; null if unknown. */
  rate(from: PresentmentCurrency, to: PresentmentCurrency): string | null;
}

/** Nest token of the configured rate source; null in deployed environments for now. */
export const FX_RATE_SOURCE = Symbol('FX_RATE_SOURCE');

/** Stored rate precision: payment_quote.fx_rate is DECIMAL(30, 12). */
export const FX_RATE_SCALE = 12;

/** Exact decimal arithmetic, wide enough for BIGINT amounts times any stored rate. */
const Exact = Prisma.Decimal.clone({ precision: 80, rounding: Prisma.Decimal.ROUND_HALF_UP });

/**
 * Deterministic, non-commercial rates for local and CI SANDBOX tests only
 * (units per euro). They are never used in a deployed environment: there,
 * no rate source is configured and every conversion is unavailable.
 */
const SYNTHETIC_UNITS_PER_EUR: Readonly<Record<PresentmentCurrency, string>> = {
  EUR: '1',
  XOF: '655.957',
  MAD: '10.8',
  MRU: '43',
};

export class SyntheticCiFxRateSource implements FxRateSource {
  readonly source = 'FX_SYNTHETIC_CI' as const;

  rate(from: PresentmentCurrency, to: PresentmentCurrency): string {
    return new Exact(SYNTHETIC_UNITS_PER_EUR[to])
      .div(SYNTHETIC_UNITS_PER_EUR[from])
      .toDecimalPlaces(FX_RATE_SCALE, Exact.ROUND_HALF_UP)
      .toFixed();
  }
}

/**
 * The presentment amount of a booking amount at a stored rate: amount x rate
 * x 10^(to minor unit - from minor unit), rounded half up to an integer. The
 * same formula as the payment_quote_presentment_from_rate CHECK, so the API
 * and PostgreSQL always agree. No JavaScript number is involved.
 */
export function convertMinor(input: {
  amountMinor: bigint;
  fromMinorUnit: number;
  toMinorUnit: number;
  rate: string;
}): bigint {
  const value = new Exact(input.amountMinor.toString())
    .mul(new Exact(input.rate))
    .mul(new Exact(10).pow(input.toMinorUnit - input.fromMinorUnit))
    .toDecimalPlaces(0, Exact.ROUND_HALF_UP);
  return BigInt(value.toFixed(0));
}

export interface FxConversion {
  /** Canonical decimal string, at most FX_RATE_SCALE decimals ("1" for identity). */
  rate: string;
  source: PaymentFxSource;
  presentmentAmountMinor: bigint;
}

@Injectable()
export class PaymentFxService {
  constructor(@Inject(FX_RATE_SOURCE) private readonly source: FxRateSource | null) {}

  /** Null when the amount or a currency is invalid, or when no rate is available. */
  convert(input: {
    amountMinor: bigint;
    fromCurrency: string;
    fromMinorUnit: number;
    toCurrency: string;
    toMinorUnit: number;
  }): FxConversion | null {
    if (input.amountMinor <= 0n) return null;
    if (!isPresentmentCurrency(input.fromCurrency) || !isPresentmentCurrency(input.toCurrency)) {
      return null;
    }
    if (input.fromCurrency === input.toCurrency) {
      if (input.fromMinorUnit !== input.toMinorUnit) return null;
      return { rate: '1', source: 'FX_IDENTITY', presentmentAmountMinor: input.amountMinor };
    }
    const raw = this.source?.rate(input.fromCurrency, input.toCurrency) ?? null;
    if (raw === null) return null;
    const rate = new Exact(raw);
    if (!rate.isFinite() || rate.lte(0)) return null;
    const stored = rate.toDecimalPlaces(FX_RATE_SCALE, Exact.ROUND_HALF_UP).toFixed();
    const presentmentAmountMinor = convertMinor({
      amountMinor: input.amountMinor,
      fromMinorUnit: input.fromMinorUnit,
      toMinorUnit: input.toMinorUnit,
      rate: stored,
    });
    if (presentmentAmountMinor <= 0n) return null;
    return { rate: stored, source: this.source!.source, presentmentAmountMinor };
  }
}
