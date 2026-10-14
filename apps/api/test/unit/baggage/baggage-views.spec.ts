import { describe, expect, it } from 'vitest';
import {
  baggageDetailView,
  baggageEventView,
  baggageSummaryView,
} from '../../../src/baggage/baggage-views.js';

const decimal = (value: string) => ({ toFixed: () => value });

const summary = {
  id: 'internal-baggage-id',
  reference: 'ETG-0123456789AB',
  type: 'SUITCASE',
  lifecycleStatus: 'CHECKED_IN',
  exceptionStatus: null,
  measuredWeightKg: decimal('12.345'),
  includedWeightKg: null,
  excessWeightKg: null,
  excessChargeMinor: null,
  excessChargeCurrencyCode: null,
  bookingId: 'internal-booking-id',
  passengerId: 'internal-passenger-id',
  createdAt: new Date('2030-01-01T00:00:00Z'),
  updatedAt: new Date('2030-01-01T01:00:00Z'),
  bookingPassenger: {
    passenger: { reference: 'ETV-0123456789AB', givenName: 'Awa', familyName: 'Ndiaye' },
    booking: {
      reference: 'ETB-0123456789AB',
      trip: {
        reference: 'ET-TEST-BAGGAGE',
        plannedDepartureAt: new Date('2030-01-02T00:00:00Z'),
        plannedArrivalAt: new Date('2030-01-03T00:00:00Z'),
        routeVersion: { route: { code: 'SYNTH', name: 'Route synthétique' } },
      },
    },
  },
};

const event = {
  id: 'internal-event-id',
  sequence: 2,
  type: 'CHECKED_IN',
  lifecycleStatus: 'CHECKED_IN',
  exceptionStatus: null,
  measuredWeightKg: decimal('12.345'),
  occurredAt: new Date('2030-01-01T01:00:00Z'),
  recordedAt: new Date('2030-01-01T01:00:01Z'),
  actorIdentityId: 'internal-actor-id',
  clientEventId: 'offline-private-id',
  payloadFingerprint: 'a'.repeat(64),
  routeWaypoint: {
    sequence: 1,
    stop: { code: 'SYN', name: 'Arrêt synthétique' },
    checkpoint: null,
  },
};

describe('baggage public views', () => {
  it('serializes Decimal as a string and excludes internal authority fields', () => {
    const view = baggageSummaryView(summary as never);
    expect(view.measuredWeightKg).toBe('12.345');
    expect(view.qrPayload).toBe('ETG1:ETG-0123456789AB');
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('internal-baggage-id');
    expect(serialized).not.toContain('internal-booking-id');
    expect(serialized).not.toContain('includedWeightKg":"0');
  });

  it('publishes a structured location but no actor, UUID or clientEventId', () => {
    const view = baggageEventView(event as never);
    expect(view.location).toEqual({
      sequence: 1,
      kind: 'STOP',
      code: 'SYN',
      name: 'Arrêt synthétique',
      checkpointType: null,
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('internal-event-id');
    expect(serialized).not.toContain('internal-actor-id');
    expect(serialized).not.toContain('offline-private-id');
    expect(serialized).not.toContain('payloadFingerprint');
  });

  it('adds only the sanitized ordered event timeline to detail', () => {
    const view = baggageDetailView({ ...summary, events: [event] } as never);
    expect(view.events).toHaveLength(1);
    expect(view.events[0]).toMatchObject({ sequence: 2, type: 'CHECKED_IN' });
  });
});
