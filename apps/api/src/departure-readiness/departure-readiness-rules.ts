import { randomInt } from 'node:crypto';
import { BOOKING_REFERENCE_ALPHABET } from '../bookings/booking-rules.js';
import { fingerprint, type CanonicalValue } from '../compliance/canonical-json.js';

export const DEPARTURE_READINESS_ENGINE_VERSION = 'departure-readiness/2';
export const DEPARTURE_PERMIT_POLICY_SCHEMA_VERSION = 'departure-permit-policy/1';
export const DEPARTURE_AUTHORIZATION_REFERENCE_PATTERN = /^ETDA-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

export type DepartureGate = 'TRIP' | 'VEHICLE' | 'PASSENGERS' | 'MANIFEST' | 'PERMITS';
export const DEPARTURE_GATES: readonly DepartureGate[] = [
  'TRIP',
  'VEHICLE',
  'PASSENGERS',
  'MANIFEST',
  'PERMITS',
];

export type DepartureBlockerCode =
  | 'TRIP_NOT_SCHEDULED'
  | 'VEHICLE_NOT_ASSIGNED'
  | 'VEHICLE_NOT_ACTIVE'
  | 'VEHICLE_SEAT_MAP_MISMATCH'
  | 'SUPPORT_VEHICLE_NOT_ACTIVE'
  | 'SUPPORT_VEHICLE_ROLE_INVALID'
  | 'SUPPORT_VEHICLE_CAPACITY_MISSING'
  | 'PASSENGER_NOT_CHECKED_IN'
  | 'PASSENGER_NOT_BOARDED'
  | 'PASSENGER_READINESS_STALE'
  | 'MANIFEST_MISSING'
  | 'MANIFEST_STALE'
  | 'PERMIT_POLICY_MISSING'
  | 'PERMIT_POLICY_STALE'
  | 'PERMIT_REQUIREMENT_UNSATISFIED';

export interface DepartureBlocker {
  gate: DepartureGate;
  code: DepartureBlockerCode;
  /** Business reference only: passenger, manifest or permit. Never an internal id. */
  reference?: string;
  /** Requirement sequence is safe operational metadata and deterministic. */
  sequence?: number;
}

export type TripOperationalStatus =
  'DRAFT' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface DeparturePassengerFact {
  passengerReference: string;
  checkedIn: boolean;
  checkInReference: string | null;
  boarded: boolean;
  boardingReference: string | null;
  currentReadinessEligible: boolean;
  /** Current PR-14 fingerprint, not its underlying facts. */
  currentReadinessFingerprint: string;
}

export interface DeparturePermitRequirementFact {
  sequence: number;
  permitType: string;
  scopeType: 'OPERATOR' | 'COUNTRY' | 'VEHICLE' | 'ROUTE_VERSION' | 'TRIP';
  countryIso2?: string;
  satisfied: boolean;
  /** Matching PR-16 business reference when satisfied. */
  permitReference?: string;
}

export interface DepartureReadinessFacts {
  trip: { reference: string; status: TripOperationalStatus };
  vehicle: null | { code: string; active: boolean; seatMapCompatible: boolean };
  supportVehicle: null | {
    code: string;
    active: boolean;
    role: 'PASSENGER_COACH' | 'CARGO_SUPPORT' | 'MIXED';
    payloadCapacityKg: number | null;
    cargoVolumeLiters: number | null;
  };
  passengers: DeparturePassengerFact[];
  manifest: null | {
    reference: string;
    version: number;
    contentHash: string;
    currentContentHash: string | null;
    passengerCount: number;
    boardedCount: number;
  };
  permitPolicy: null | {
    version: number;
    contentHash: string;
    currentContentHash: string;
    requirementCount: number;
    requirements: DeparturePermitRequirementFact[];
  };
}

export interface DepartureReadiness {
  engineVersion: typeof DEPARTURE_READINESS_ENGINE_VERSION;
  status: 'READY' | 'BLOCKED';
  gates: Array<{
    gate: DepartureGate;
    status: 'PASS' | 'BLOCKED';
    blockers: DepartureBlockerCode[];
  }>;
  blockers: DepartureBlocker[];
}

export interface DepartureReadinessSnapshot {
  engineVersion: typeof DEPARTURE_READINESS_ENGINE_VERSION;
  status: 'READY' | 'BLOCKED';
  trip: { reference: string; status: TripOperationalStatus };
  vehicle: null | { code: string; active: boolean; seatMapCompatible: boolean };
  supportVehicle: DepartureReadinessFacts['supportVehicle'];
  passengers: {
    total: number;
    checkedIn: number;
    boarded: number;
    currentReady: number;
    factsFingerprint: string;
  };
  manifest: null | {
    reference: string;
    version: number;
    contentHash: string;
    currentContentHash: string | null;
    passengerCount: number;
    boardedCount: number;
  };
  permitPolicy: null | {
    version: number;
    contentHash: string;
    currentContentHash: string;
    requirementCount: number;
    requirements: Array<{
      sequence: number;
      permitType: string;
      scopeType: DeparturePermitRequirementFact['scopeType'];
      countryIso2?: string;
      satisfied: boolean;
      permitReference?: string;
    }>;
  };
  gates: DepartureReadiness['gates'];
  blockers: DepartureBlocker[];
}

const blocker = (
  gate: DepartureGate,
  code: DepartureBlockerCode,
  details: Pick<DepartureBlocker, 'reference' | 'sequence'> = {},
): DepartureBlocker => ({ gate, code, ...details });

const passengerOrder = (left: DeparturePassengerFact, right: DeparturePassengerFact) =>
  left.passengerReference.localeCompare(right.passengerReference, 'en');

const requirementOrder = (
  left: DeparturePermitRequirementFact,
  right: DeparturePermitRequirementFact,
) => left.sequence - right.sequence;

export function deriveDepartureReadiness(facts: DepartureReadinessFacts): DepartureReadiness {
  const blockers: DepartureBlocker[] = [];

  if (facts.trip.status !== 'SCHEDULED') {
    blockers.push(blocker('TRIP', 'TRIP_NOT_SCHEDULED'));
  }

  if (!facts.vehicle) {
    blockers.push(blocker('VEHICLE', 'VEHICLE_NOT_ASSIGNED'));
  } else {
    if (!facts.vehicle.active) blockers.push(blocker('VEHICLE', 'VEHICLE_NOT_ACTIVE'));
    if (!facts.vehicle.seatMapCompatible) {
      blockers.push(blocker('VEHICLE', 'VEHICLE_SEAT_MAP_MISMATCH'));
    }
  }

  if (facts.supportVehicle) {
    if (!facts.supportVehicle.active) {
      blockers.push(blocker('VEHICLE', 'SUPPORT_VEHICLE_NOT_ACTIVE'));
    }
    if (facts.supportVehicle.role !== 'CARGO_SUPPORT') {
      blockers.push(blocker('VEHICLE', 'SUPPORT_VEHICLE_ROLE_INVALID'));
    }
    if (
      facts.supportVehicle.payloadCapacityKg === null ||
      facts.supportVehicle.cargoVolumeLiters === null
    ) {
      blockers.push(blocker('VEHICLE', 'SUPPORT_VEHICLE_CAPACITY_MISSING'));
    }
  }

  for (const passenger of [...facts.passengers].sort(passengerOrder)) {
    if (!passenger.checkedIn) {
      blockers.push(
        blocker('PASSENGERS', 'PASSENGER_NOT_CHECKED_IN', {
          reference: passenger.passengerReference,
        }),
      );
    }
    if (!passenger.boarded) {
      blockers.push(
        blocker('PASSENGERS', 'PASSENGER_NOT_BOARDED', {
          reference: passenger.passengerReference,
        }),
      );
    }
    if (!passenger.currentReadinessEligible) {
      blockers.push(
        blocker('PASSENGERS', 'PASSENGER_READINESS_STALE', {
          reference: passenger.passengerReference,
        }),
      );
    }
  }

  if (!facts.manifest) {
    blockers.push(blocker('MANIFEST', 'MANIFEST_MISSING'));
  } else if (facts.manifest.contentHash !== facts.manifest.currentContentHash) {
    blockers.push(blocker('MANIFEST', 'MANIFEST_STALE', { reference: facts.manifest.reference }));
  }

  if (!facts.permitPolicy) {
    blockers.push(blocker('PERMITS', 'PERMIT_POLICY_MISSING'));
  } else {
    if (facts.permitPolicy.contentHash !== facts.permitPolicy.currentContentHash) {
      blockers.push(blocker('PERMITS', 'PERMIT_POLICY_STALE'));
    }
    for (const requirement of [...facts.permitPolicy.requirements].sort(requirementOrder)) {
      if (!requirement.satisfied) {
        blockers.push(
          blocker('PERMITS', 'PERMIT_REQUIREMENT_UNSATISFIED', {
            sequence: requirement.sequence,
          }),
        );
      }
    }
  }

  const gates = DEPARTURE_GATES.map((gate) => {
    const gateBlockers = blockers.filter((item) => item.gate === gate).map((item) => item.code);
    return {
      gate,
      status: gateBlockers.length === 0 ? ('PASS' as const) : ('BLOCKED' as const),
      blockers: [...new Set(gateBlockers)],
    };
  });

  return {
    engineVersion: DEPARTURE_READINESS_ENGINE_VERSION,
    status: blockers.length === 0 ? 'READY' : 'BLOCKED',
    gates,
    blockers,
  };
}

function passengerFactsFingerprint(passengers: DeparturePassengerFact[]): string {
  const value = [...passengers].sort(passengerOrder).map((item) => ({
    passengerReference: item.passengerReference,
    checkedIn: item.checkedIn,
    checkInReference: item.checkInReference,
    boarded: item.boarded,
    boardingReference: item.boardingReference,
    currentReadinessEligible: item.currentReadinessEligible,
    currentReadinessFingerprint: item.currentReadinessFingerprint,
  })) as CanonicalValue;
  return fingerprint(value);
}

export function departureReadinessSnapshot(
  facts: DepartureReadinessFacts,
  readiness = deriveDepartureReadiness(facts),
): DepartureReadinessSnapshot {
  const passengers = [...facts.passengers].sort(passengerOrder);
  const requirements = facts.permitPolicy
    ? [...facts.permitPolicy.requirements].sort(requirementOrder).map((requirement) => ({
        sequence: requirement.sequence,
        permitType: requirement.permitType,
        scopeType: requirement.scopeType,
        ...(requirement.countryIso2 ? { countryIso2: requirement.countryIso2 } : {}),
        satisfied: requirement.satisfied,
        ...(requirement.permitReference ? { permitReference: requirement.permitReference } : {}),
      }))
    : null;

  return {
    engineVersion: DEPARTURE_READINESS_ENGINE_VERSION,
    status: readiness.status,
    trip: { ...facts.trip },
    vehicle: facts.vehicle ? { ...facts.vehicle } : null,
    supportVehicle: facts.supportVehicle ? { ...facts.supportVehicle } : null,
    passengers: {
      total: passengers.length,
      checkedIn: passengers.filter((item) => item.checkedIn).length,
      boarded: passengers.filter((item) => item.boarded).length,
      currentReady: passengers.filter((item) => item.currentReadinessEligible).length,
      factsFingerprint: passengerFactsFingerprint(passengers),
    },
    manifest: facts.manifest ? { ...facts.manifest } : null,
    permitPolicy: facts.permitPolicy
      ? {
          version: facts.permitPolicy.version,
          contentHash: facts.permitPolicy.contentHash,
          currentContentHash: facts.permitPolicy.currentContentHash,
          requirementCount: facts.permitPolicy.requirementCount,
          requirements: requirements!,
        }
      : null,
    gates: readiness.gates.map((gate) => ({ ...gate, blockers: [...gate.blockers] })),
    blockers: readiness.blockers.map((item) => ({ ...item })),
  };
}

export function departureReadinessFingerprint(
  facts: DepartureReadinessFacts,
  readiness = deriveDepartureReadiness(facts),
): string {
  return fingerprint(departureReadinessSnapshot(facts, readiness) as unknown as CanonicalValue);
}

export function departurePermitPolicyContentHash(input: {
  tripReference: string;
  version: number;
  requirements: Array<{
    sequence: number;
    permitType: string;
    scopeType: DeparturePermitRequirementFact['scopeType'];
    countryIso2?: string;
  }>;
}): string {
  const value = {
    schemaVersion: DEPARTURE_PERMIT_POLICY_SCHEMA_VERSION,
    tripReference: input.tripReference,
    version: input.version,
    requirements: [...input.requirements]
      .sort((left, right) => left.sequence - right.sequence)
      .map((requirement) => ({
        sequence: requirement.sequence,
        permitType: requirement.permitType,
        scopeType: requirement.scopeType,
        ...(requirement.countryIso2 ? { countryIso2: requirement.countryIso2 } : {}),
      })),
  } as CanonicalValue;
  return fingerprint(value);
}

function randomBody(length: number, random: (max: number) => number): string {
  let body = '';
  for (let index = 0; index < length; index += 1) {
    body += BOOKING_REFERENCE_ALPHABET[random(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return body;
}

const csprng = (max: number) => randomInt(max);
export const generateDepartureAuthorizationReference = (random = csprng) =>
  `ETDA-${randomBody(12, random)}`;

export function normalizeDepartureAuthorizationReference(value: string): string | null {
  const reference = value.trim().toUpperCase();
  return DEPARTURE_AUTHORIZATION_REFERENCE_PATTERN.test(reference) ? reference : null;
}
