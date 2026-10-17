import { describe, expect, it } from 'vitest';
import { delayMinutes, exactRatio, integerAverageMinor, safeRate } from './reporting-rules.js';

describe('PR-23 reporting rules', () => {
  it('never divides occupancy by zero', () => {
    expect(safeRate(0, 0)).toBeNull();
    expect(safeRate(0, 10)).toBe(0);
    expect(safeRate(8, 10)).toBe(0.8);
  });

  it('defines on-time as no positive departure delay', () => {
    const planned = new Date('2026-10-17T10:00:00.000Z');
    expect(delayMinutes(planned, new Date('2026-10-17T10:00:00.000Z'))).toBe(0);
    expect(delayMinutes(planned, new Date('2026-10-17T10:01:00.000Z'))).toBe(1);
    expect(delayMinutes(planned, new Date('2026-10-17T09:55:00.000Z'))).toBe(0);
    expect(delayMinutes(planned, null)).toBeNull();
  });

  it('keeps money averages in integer minor units', () => {
    expect(integerAverageMinor(1001n, 2)).toBe('500');
    expect(integerAverageMinor(1001n, 0)).toBeNull();
  });

  it('computes a bounded display ratio without converting money to float first', () => {
    expect(exactRatio(2500n, 10_000n)).toBe(0.25);
    expect(exactRatio(-2500n, 10_000n)).toBe(-0.25);
    expect(exactRatio(1n, 0n)).toBeNull();
  });
});
