import { describe, expect, it } from 'vitest';
import { publicCargoTrackingStatus } from '../../../src/cargo/cargo-tracking-rules.js';

describe('public cargo tracking status', () => {
  it('projects internal lifecycle into a bounded public vocabulary', () => {
    expect(publicCargoTrackingStatus('QUOTE', null)).toBe('PREPARING');
    expect(publicCargoTrackingStatus('INSPECTED', null)).toBe('RECEIVED');
    expect(publicCargoTrackingStatus('IN_TRANSIT', null)).toBe('IN_TRANSIT');
    expect(publicCargoTrackingStatus('ARRIVED', null)).toBe('ARRIVED');
    expect(publicCargoTrackingStatus('AVAILABLE', null)).toBe('AVAILABLE');
    expect(publicCargoTrackingStatus('DELIVERED', null)).toBe('DELIVERED');
    expect(publicCargoTrackingStatus('CANCELLED', null)).toBe('CANCELLED');
    expect(publicCargoTrackingStatus('REFUSED', null)).toBe('CANCELLED');
  });

  it('collapses sensitive exception types into ATTENTION', () => {
    expect(publicCargoTrackingStatus('RECEIVED', 'HELD')).toBe('ATTENTION');
    expect(publicCargoTrackingStatus('IN_TRANSIT', 'CUSTOMS_HOLD')).toBe('ATTENTION');
    expect(publicCargoTrackingStatus('ARRIVED', 'DAMAGED')).toBe('ATTENTION');
  });
});
