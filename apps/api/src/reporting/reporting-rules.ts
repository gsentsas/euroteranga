export function safeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export function delayMinutes(
  plannedDepartureAt: Date | null,
  actualDepartureAt: Date | null,
): number | null {
  if (!plannedDepartureAt || !actualDepartureAt) return null;
  return Math.max(0, (actualDepartureAt.getTime() - plannedDepartureAt.getTime()) / 60_000);
}

export function integerAverageMinor(totalMinor: bigint, count: number): string | null {
  if (count <= 0) return null;
  return (totalMinor / BigInt(count)).toString();
}

export function exactRatio(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return null;
  const scaled = (numerator * 1_000_000n) / denominator;
  const absolute = scaled < 0n ? -scaled : scaled;
  if (absolute > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(scaled) / 1_000_000;
}
