import { describe, expect, it } from 'vitest';
import {
  CARGO_QR_PATTERN,
  CARGO_REFERENCE_PATTERN,
  CargoTransitionError,
  cargoEventFingerprint,
  cargoQrPayload,
  generateCargoReference,
  normalizeCargoReference,
  normalizeCargoWeightKg,
  parseCargoQrPayload,
  projectCargoEvent,
  withFreshCargoReference,
  type CargoProjection,
} from '../../../src/cargo/cargo-rules.js';

describe('cargo identity and exact weight', () => {
  it('creates opaque ETC references and normalizes exact kilograms', () => {
    const reference = generateCargoReference(() => 31);
    expect(reference).toBe('ETC-ZZZZZZZZZZZZ');
    expect(reference).toMatch(CARGO_REFERENCE_PATTERN);
    expect(normalizeCargoReference(' etc-0123456789ab ')).toBe('ETC-0123456789AB');
    expect(normalizeCargoReference('ETC-ILOU01234567')).toBeNull();

    expect(cargoQrPayload('ETC-0123456789AB')).toBe('ETC1:ETC-0123456789AB');
    expect('ETC1:ETC-0123456789AB').toMatch(CARGO_QR_PATTERN);
    expect(parseCargoQrPayload(' etc1:etc-0123456789ab ')).toBe('ETC-0123456789AB');
    expect(parseCargoQrPayload('ETC-0123456789AB')).toBeNull();
    expect(parseCargoQrPayload('ETC2:ETC-0123456789AB')).toBeNull();

    expect(normalizeCargoWeightKg('1')).toBe('1.000');
    expect(normalizeCargoWeightKg('12.3')).toBe('12.300');
    expect(normalizeCargoWeightKg('99999.999')).toBe('99999.999');
    for (const invalid of ['0', '-1', '100000', '1.2345', '1e2']) {
      expect(normalizeCargoWeightKg(invalid)).toBeNull();
    }
  });

  it('retries reference collisions without masking other errors', async () => {
    const generated = ['ETC-000000000000', 'ETC-111111111111'];
    let calls = 0;
    const result = await withFreshCargoReference(
      async (reference) => {
        calls += 1;
        if (calls === 1) throw new Error('collision');
        return reference;
      },
      (error) => String(error).includes('collision'),
      () => generated.shift()!,
    );
    expect(result).toBe('ETC-111111111111');
    await expect(
      withFreshCargoReference(
        async () => {
          throw new Error('database unavailable');
        },
        () => false,
      ),
    ).rejects.toThrow('database unavailable');
  });
});

describe('cargo event projection', () => {
  const quote = (): CargoProjection => ({ lifecycleStatus: 'QUOTE', exceptionStatus: null });

  it('proves the complete normal lifecycle', () => {
    let projection = quote();
    for (const event of [
      'BOOKED',
      'RECEIVED',
      'INSPECTED',
      'ASSIGNED',
      'LOADED',
      'DEPARTED',
      'IN_TRANSIT',
      'ARRIVED',
      'AVAILABLE',
      'DELIVERED',
    ] as const) {
      projection = projectCargoEvent(projection, event);
    }
    expect(projection).toEqual({ lifecycleStatus: 'DELIVERED', exceptionStatus: null });
  });

  it('keeps exceptions separate and blocks progress until resolution', () => {
    let projection = projectCargoEvent(quote(), 'BOOKED');
    projection = projectCargoEvent(projection, 'RECEIVED');
    const held = projectCargoEvent(projection, 'CUSTOMS_HOLD');
    expect(held).toEqual({ lifecycleStatus: 'RECEIVED', exceptionStatus: 'CUSTOMS_HOLD' });
    expect(() => projectCargoEvent(held, 'INSPECTED')).toThrow(CargoTransitionError);
    const cleared = projectCargoEvent(held, 'EXCEPTION_RESOLVED');
    expect(projectCargoEvent(cleared, 'INSPECTED').lifecycleStatus).toBe('INSPECTED');
  });

  it('allows cancellation only before loading and makes terminal states immutable', () => {
    const assigned = projectCargoEvent(
      projectCargoEvent(
        projectCargoEvent(projectCargoEvent(quote(), 'BOOKED'), 'RECEIVED'),
        'INSPECTED',
      ),
      'ASSIGNED',
    );
    expect(projectCargoEvent(assigned, 'CANCELLED').lifecycleStatus).toBe('CANCELLED');

    const loaded = projectCargoEvent(assigned, 'LOADED');
    expect(() => projectCargoEvent(loaded, 'CANCELLED')).toThrow(CargoTransitionError);
    const refused = projectCargoEvent(loaded, 'REFUSED');
    expect(() => projectCargoEvent(refused, 'DAMAGED')).toThrow(CargoTransitionError);
  });

  it('fingerprints event type, time, location and assignment', () => {
    const base = {
      type: 'IN_TRANSIT' as const,
      occurredAt: new Date('2030-01-02T03:04:05.000Z'),
      routeWaypointId: null,
      tripId: 'trip-a',
      vehicleId: 'vehicle-a',
    };
    const fingerprint = cargoEventFingerprint(base);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(cargoEventFingerprint({ ...base })).toBe(fingerprint);
    expect(cargoEventFingerprint({ ...base, vehicleId: 'vehicle-b' })).not.toBe(fingerprint);
  });
});
