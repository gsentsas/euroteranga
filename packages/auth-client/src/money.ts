/**
 * Exact money helpers. Amounts are integers in the currency's minor unit
 * (EUR 125,50 -> 12550 with minor unit 2; XOF 15 000 -> 15000 with minor
 * unit 0). Conversions use integer/BigInt arithmetic only: no floating point,
 * no toFixed. Display depends on the locale; the business value never does.
 */

/** Largest amount accepted by the API (PostgreSQL INTEGER). */
export const MAX_AMOUNT_MINOR = 2_147_483_647;

function assertMinorUnit(minorUnit: number): void {
  if (!Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 3) {
    throw new RangeError('currency minor unit must be an integer between 0 and 3');
  }
}

/** "12550" + minor unit 2 -> "125.50" (exact decimal string). */
export function minorToDecimalString(amountMinor: number, minorUnit: number): string {
  assertMinorUnit(minorUnit);
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError('amount must be a safe integer');
  const negative = amountMinor < 0;
  const absolute = BigInt(Math.abs(amountMinor));
  const factor = 10n ** BigInt(minorUnit);
  const integer = (absolute / factor).toString();
  const fraction = (absolute % factor).toString().padStart(minorUnit, '0');
  return `${negative ? '-' : ''}${integer}${minorUnit > 0 ? `.${fraction}` : ''}`;
}

/**
 * Display an exact amount, e.g. 12550/EUR/2 -> "125,50 EUR" and
 * 15000/XOF/0 -> "15 000 XOF" in fr-FR (with non-breaking spaces).
 */
export function formatMoney(
  amountMinor: number,
  currencyCode: string,
  minorUnit: number,
  locale = 'fr-FR',
): string {
  const decimal = minorToDecimalString(amountMinor, minorUnit);
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    currencyDisplay: 'code',
    minimumFractionDigits: minorUnit,
    maximumFractionDigits: minorUnit,
  });
  // A numeric string is formatted exactly (Intl.NumberFormat v3), never via a float.
  return formatter.format(decimal as `${number}`);
}

/**
 * Parse a user-entered amount into minor units, exactly. Accepts digits with
 * spaces as thousand separators and one "," or "." decimal separator, at most
 * `minorUnit` decimals (no rounding). Returns null when the input is not a
 * positive amount representable by the API.
 */
export function parseMoneyToMinor(input: string, minorUnit: number): number | null {
  assertMinorUnit(minorUnit);
  const cleaned = input.replace(/[\s\u00a0\u202f]/g, '');
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(cleaned);
  if (!match) return null;
  const integer = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > minorUnit) return null;
  const minor =
    BigInt(integer) * 10n ** BigInt(minorUnit) + BigInt(fraction.padEnd(minorUnit, '0') || '0');
  if (minor < 1n || minor > BigInt(MAX_AMOUNT_MINOR)) return null;
  return Number(minor);
}

/**
 * Exact multiplication of an amount by a count (e.g. a per-seat fare by the
 * number of seats): BigInt arithmetic, returned only as a safe integer.
 * Display helper for a summary; the server computes the authoritative total.
 */
export function multiplyAmountMinor(amountMinor: number, count: number): number {
  if (!Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('amount and count must be safe integers');
  }
  const total = BigInt(amountMinor) * BigInt(count);
  const value = Number(total);
  if (!Number.isSafeInteger(value) || BigInt(value) !== total) {
    throw new RangeError('total exceeds the safe integer range');
  }
  return value;
}
