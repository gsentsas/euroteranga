import { describe, expect, it } from 'vitest';
import {
  DEPARTURE_AUTHORIZATION_REFERENCE_PATTERN,
  DEPARTURE_GATES,
  departurePermitPolicyContentHash,
  departureReadinessFingerprint,
  departureReadinessSnapshot,
  deriveDepartureReadiness,
  generateDepartureAuthorizationReference,
  type DepartureReadinessFacts,
} from '../../../src/departure-readiness/departure-readiness-rules.js';

function readyFacts(): DepartureReadinessFacts {
  const requirements = [
    {
      sequence: 1,
      permitType: 'SYNTHETIC_OPERATOR',
      scopeType: 'OPERATOR' as const,
      satisfied: true,
      permitReference: 'ETRP-111111111111',
    },
  ];
  const policyHash = departurePermitPolicyContentHash({
    tripReference: 'ET-TEST-2030-0001',
    version: 1,
    requirements,
  });
  return {
    trip: { reference: 'ET-TEST-2030-0001', status: 'SCHEDULED' },
    vehicle: { code: 'BUS-01', active: true, seatMapCompatible: true },
    supportVehicle: null,
    passengers: [
      {
        passengerReference: 'ETV-222222222222',
        checkedIn: true,
        checkInReference: 'ETK-222222222222',
        boarded: true,
        boardingReference: 'ETE-222222222222',
        currentReadinessEligible: true,
        currentReadinessFingerprint: 'b'.repeat(64),
      },
      {
        passengerReference: 'ETV-111111111111',
        checkedIn: true,
        checkInReference: 'ETK-111111111111',
        boarded: true,
        boardingReference: 'ETE-111111111111',
        currentReadinessEligible: true,
        currentReadinessFingerprint: 'a'.repeat(64),
      },
    ],
    manifest: {
      reference: 'ETM-111111111111',
      version: 2,
      contentHash: 'c'.repeat(64),
      currentContentHash: 'c'.repeat(64),
      passengerCount: 2,
      boardedCount: 2,
    },
    permitPolicy: {
      version: 1,
      contentHash: policyHash,
      currentContentHash: policyHash,
      requirementCount: 1,
      requirements,
    },
  };
}

describe('departure readiness rules', () => {
  it('generates Crockford ETDA references', () => {
    expect(generateDepartureAuthorizationReference(() => 0)).toBe('ETDA-000000000000');
    expect(generateDepartureAuthorizationReference(() => 31)).toBe('ETDA-ZZZZZZZZZZZZ');
    expect(generateDepartureAuthorizationReference(() => 0)).toMatch(
      DEPARTURE_AUTHORIZATION_REFERENCE_PATTERN,
    );
  });

  it('passes all five gates only when all current server facts pass', () => {
    const readiness = deriveDepartureReadiness(readyFacts());
    expect(readiness.status).toBe('READY');
    expect(readiness.gates.map((gate) => [gate.gate, gate.status])).toEqual(
      DEPARTURE_GATES.map((gate) => [gate, 'PASS']),
    );
    expect(readiness.blockers).toEqual([]);
  });

  it('blocks every domain independently and preserves deterministic gate order', () => {
    const facts = readyFacts();
    facts.trip.status = 'IN_PROGRESS';
    facts.vehicle = { code: 'BUS-01', active: false, seatMapCompatible: false };
    facts.passengers[0] = {
      ...facts.passengers[0]!,
      checkedIn: false,
      checkInReference: null,
      boarded: false,
      boardingReference: null,
      currentReadinessEligible: false,
    };
    facts.manifest!.currentContentHash = 'd'.repeat(64);
    const requirement = facts.permitPolicy!.requirements[0]!;
    facts.permitPolicy!.requirements[0] = {
      sequence: requirement.sequence,
      permitType: requirement.permitType,
      scopeType: requirement.scopeType,
      ...(requirement.countryIso2 ? { countryIso2: requirement.countryIso2 } : {}),
      satisfied: false,
    };
    const readiness = deriveDepartureReadiness(facts);
    expect(readiness.status).toBe('BLOCKED');
    expect(readiness.gates.map((gate) => gate.gate)).toEqual(DEPARTURE_GATES);
    expect(readiness.blockers.map((item) => item.code)).toEqual([
      'TRIP_NOT_SCHEDULED',
      'VEHICLE_NOT_ACTIVE',
      'VEHICLE_SEAT_MAP_MISMATCH',
      'PASSENGER_NOT_CHECKED_IN',
      'PASSENGER_NOT_BOARDED',
      'PASSENGER_READINESS_STALE',
      'MANIFEST_STALE',
      'PERMIT_REQUIREMENT_UNSATISFIED',
    ]);
  });

  it('distinguishes missing permit policy from an explicit published empty policy', () => {
    const missing = readyFacts();
    missing.permitPolicy = null;
    expect(deriveDepartureReadiness(missing).blockers.map((item) => item.code)).toContain(
      'PERMIT_POLICY_MISSING',
    );

    const explicitEmpty = readyFacts();
    const contentHash = departurePermitPolicyContentHash({
      tripReference: explicitEmpty.trip.reference,
      version: 2,
      requirements: [],
    });
    explicitEmpty.permitPolicy = {
      version: 2,
      contentHash,
      currentContentHash: contentHash,
      requirementCount: 0,
      requirements: [],
    };
    expect(
      deriveDepartureReadiness(explicitEmpty).gates.find((gate) => gate.gate === 'PERMITS'),
    ).toEqual({ gate: 'PERMITS', status: 'PASS', blockers: [] });
  });

  it('detects stale manifest and stale policy hashes', () => {
    const facts = readyFacts();
    facts.manifest!.currentContentHash = 'e'.repeat(64);
    facts.permitPolicy!.currentContentHash = 'f'.repeat(64);
    expect(deriveDepartureReadiness(facts).blockers.map((item) => item.code)).toEqual([
      'MANIFEST_STALE',
      'PERMIT_POLICY_STALE',
    ]);
  });

  it('fingerprints passenger current-readiness changes but is independent of input ordering', () => {
    const first = readyFacts();
    const second = readyFacts();
    second.passengers.reverse();
    second.permitPolicy!.requirements.reverse();
    expect(departureReadinessFingerprint(first)).toBe(departureReadinessFingerprint(second));

    second.passengers[0] = {
      ...second.passengers[0]!,
      currentReadinessFingerprint: '9'.repeat(64),
    };
    expect(departureReadinessFingerprint(first)).not.toBe(departureReadinessFingerprint(second));
  });

  it('minimizes the authorization snapshot and never copies forbidden passenger facts', () => {
    const unsafe = readyFacts() as DepartureReadinessFacts & {
      customerEmail?: string;
      documentNumber?: string;
      qrCredential?: string;
      actorIdentityId?: string;
      paymentReference?: string;
    };
    unsafe.customerEmail = 'private@example.test';
    unsafe.documentNumber = 'P1234567';
    unsafe.qrCredential = 'ETQ-SECRET';
    unsafe.actorIdentityId = '00000000-0000-7000-8000-000000000001';
    unsafe.paymentReference = 'ETP-SECRET';
    const serialized = JSON.stringify(departureReadinessSnapshot(unsafe));
    for (const forbidden of [
      'customerEmail',
      'private@example.test',
      'documentNumber',
      'P1234567',
      'qrCredential',
      'ETQ-SECRET',
      'actorIdentityId',
      '00000000-0000-7000-8000-000000000001',
      'paymentReference',
      'ETP-SECRET',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain('givenName');
    expect(serialized).not.toContain('familyName');
  });
});
