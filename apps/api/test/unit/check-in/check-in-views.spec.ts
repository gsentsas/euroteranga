import { describe, expect, it } from 'vitest';
import { deriveReadiness } from '../../../src/check-in/check-in-rules.js';
import {
  customerCheckInView,
  readinessView,
  staffCheckInView,
  type CheckInRow,
} from '../../../src/check-in/check-in-views.js';

const row = (boarded: boolean, realm: 'CUSTOMER' | 'STAFF' = 'CUSTOMER') =>
  ({
    id: 'internal-check-in-id',
    reference: 'ETK-0123456789AB',
    credentialReference: 'ETQ-0123456789ABCDEF',
    bookingId: 'internal-booking-id',
    passengerId: 'internal-passenger-id',
    engineVersion: 'checkin-readiness/1',
    readinessFingerprint: 'a'.repeat(64),
    readinessSnapshot: { checks: [{ check: 'BOOKING', status: 'PASS' }] },
    checkedInAt: new Date('2030-01-01T08:00:00.000Z'),
    checkedInBy: { realm },
    seatAssignment: { bookingSeat: { seatMapCell: { seatLabel: '1A' } } },
    bookingPassenger: {
      passenger: { reference: 'ETV-0123456789AB', givenName: 'Awa', familyName: 'Ndiaye' },
      booking: {
        reference: 'ETB-0123456789AB',
        trip: {
          reference: 'ET-TEST-CHECKIN',
          plannedDepartureAt: new Date('2030-01-02T08:00:00.000Z'),
          plannedArrivalAt: new Date('2030-01-02T12:00:00.000Z'),
          routeVersion: { route: { code: 'SYN', name: 'Route synthétique' } },
        },
      },
    },
    boarding: boarded
      ? {
          reference: 'ETE-0123456789AB',
          boardedAt: new Date('2030-01-02T07:50:00.000Z'),
          occurredAt: new Date('2030-01-02T07:49:59.000Z'),
          deviceId: 'gate-01',
          readinessFingerprint: 'b'.repeat(64),
        }
      : null,
  }) as unknown as CheckInRow;

describe('check-in public views', () => {
  it('gives the customer references, seat, trip and QR payload only', () => {
    const view = customerCheckInView(row(true));
    expect(view).toEqual({
      reference: 'ETK-0123456789AB',
      checkedInAt: new Date('2030-01-01T08:00:00.000Z'),
      qrPayload: 'ETPAX1:ETQ-0123456789ABCDEF',
      seat: { label: '1A' },
      passenger: { reference: 'ETV-0123456789AB', givenName: 'Awa', familyName: 'Ndiaye' },
      booking: { reference: 'ETB-0123456789AB' },
      trip: {
        reference: 'ET-TEST-CHECKIN',
        route: { code: 'SYN', name: 'Route synthétique' },
        plannedDepartureAt: new Date('2030-01-02T08:00:00.000Z'),
        plannedArrivalAt: new Date('2030-01-02T12:00:00.000Z'),
      },
      boarding: { reference: 'ETE-0123456789AB', boardedAt: new Date('2030-01-02T07:50:00.000Z') },
    });
    const serialized = JSON.stringify(view);
    for (const forbidden of ['internal-', 'gate-01', 'a'.repeat(64), 'checks', 'STAFF']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('adds the operational facts for STAFF, with current readiness when known', () => {
    const readiness = deriveReadiness({
      booking: { reference: 'ETB-0123456789AB', confirmed: true, cancelled: false },
      trip: { reference: 'ET-TEST-CHECKIN', status: 'SCHEDULED' },
      payment: null,
      seat: null,
      compliance: {
        status: 'STALE',
        evaluation: null,
        review: null,
        evidence: [],
        findingCodes: [],
      },
      baggage: [],
    });
    const view = staffCheckInView(row(true, 'STAFF'), { readiness, fingerprint: 'c'.repeat(64) });
    expect(view).toMatchObject({
      channel: 'STAFF',
      engineVersion: 'checkin-readiness/1',
      checksAtCheckIn: [{ check: 'BOOKING', status: 'PASS' }],
      current: false,
      factsChangedSinceCheckIn: true,
      boarding: { reference: 'ETE-0123456789AB', deviceId: 'gate-01' },
    });
    expect(JSON.stringify(view)).not.toContain('internal-');
    expect(staffCheckInView(row(false))).not.toHaveProperty('current');
    expect(staffCheckInView(row(false)).channel).toBe('CUSTOMER');
  });

  it('exposes readiness as stable codes plus PR-12 customer guidance', () => {
    const readiness = deriveReadiness({
      booking: { reference: 'ETB-0123456789AB', confirmed: true, cancelled: false },
      trip: { reference: 'ET-TEST-CHECKIN', status: 'SCHEDULED' },
      payment: { reference: 'ETP-0123456789AB' },
      seat: null,
      compliance: {
        status: 'COMPLIANT',
        evaluation: null,
        review: { id: 'review', decision: 'COMPLIANT' },
        evidence: [],
        findingCodes: [],
      },
      baggage: [],
    });
    expect(readinessView(readiness, ['Consigne synthétique.'])).toEqual({
      engineVersion: 'checkin-readiness/1',
      eligible: false,
      checks: readiness.checks,
      blockers: [{ check: 'SEAT', code: 'SEAT_NOT_ASSIGNED' }],
      complianceGuidance: ['Consigne synthétique.'],
    });
  });
});
