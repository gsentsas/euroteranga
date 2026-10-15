import type { Prisma } from '@euroteranga/database';
import { boardingQrPayload, type Readiness } from './check-in-rules.js';

export const tripSelect = {
  reference: true,
  plannedDepartureAt: true,
  plannedArrivalAt: true,
  routeVersion: { select: { route: { select: { code: true, name: true } } } },
} as const satisfies Prisma.TripSelect;

const seatLabelSelect = {
  bookingSeat: { select: { seatMapCell: { select: { seatLabel: true } } } },
} as const;

export const checkInSelect = {
  id: true,
  reference: true,
  credentialReference: true,
  bookingId: true,
  passengerId: true,
  engineVersion: true,
  readinessFingerprint: true,
  readinessSnapshot: true,
  checkedInAt: true,
  checkedInBy: { select: { realm: true } },
  seatAssignment: { select: seatLabelSelect },
  bookingPassenger: {
    select: {
      passenger: { select: { reference: true, givenName: true, familyName: true } },
      booking: { select: { reference: true, trip: { select: tripSelect } } },
    },
  },
  boarding: {
    select: {
      reference: true,
      boardedAt: true,
      occurredAt: true,
      deviceId: true,
      readinessFingerprint: true,
    },
  },
} as const satisfies Prisma.PassengerCheckInSelect;

export type CheckInRow = Prisma.PassengerCheckInGetPayload<{ select: typeof checkInSelect }>;

export function tripView(trip: Prisma.TripGetPayload<{ select: typeof tripSelect }>) {
  return {
    reference: trip.reference,
    route: trip.routeVersion.route,
    plannedDepartureAt: trip.plannedDepartureAt,
    plannedArrivalAt: trip.plannedArrivalAt,
  };
}

/**
 * CUSTOMER view of a check-in: references, seat, trip, passenger and the
 * PII-free QR payload. No UUID, actor, device id, fingerprint or snapshot.
 */
export function customerCheckInView(row: CheckInRow) {
  return {
    reference: row.reference,
    checkedInAt: row.checkedInAt,
    qrPayload: boardingQrPayload(row.credentialReference),
    // Booked cells are SEAT cells, whose label is mandatory (PR-07 CHECK).
    seat: { label: row.seatAssignment.bookingSeat.seatMapCell.seatLabel ?? '' },
    passenger: row.bookingPassenger.passenger,
    booking: { reference: row.bookingPassenger.booking.reference },
    trip: tripView(row.bookingPassenger.booking.trip),
    boarding: row.boarding
      ? { reference: row.boarding.reference, boardedAt: row.boarding.boardedAt }
      : null,
  };
}

/**
 * STAFF view: adds the channel, the readiness recorded at check-in and the
 * boarding facts (device id is operational metadata, not an identity proof).
 */
export function staffCheckInView(
  row: CheckInRow,
  current?: { readiness: Readiness; fingerprint: string },
) {
  const snapshot = row.readinessSnapshot as { checks?: unknown } | null;
  return {
    ...customerCheckInView(row),
    channel: row.checkedInBy.realm === 'CUSTOMER' ? ('CUSTOMER' as const) : ('STAFF' as const),
    engineVersion: row.engineVersion,
    checksAtCheckIn: snapshot?.checks ?? [],
    ...(current
      ? {
          current: current.readiness.eligible,
          factsChangedSinceCheckIn: current.fingerprint !== row.readinessFingerprint,
        }
      : {}),
    boarding: row.boarding
      ? {
          reference: row.boarding.reference,
          boardedAt: row.boarding.boardedAt,
          occurredAt: row.boarding.occurredAt,
          deviceId: row.boarding.deviceId,
        }
      : null,
  };
}

/** Public readiness: codes only, the UI maps them to text. */
export function readinessView(readiness: Readiness, guidance: string[]) {
  return {
    engineVersion: readiness.engineVersion,
    eligible: readiness.eligible,
    checks: readiness.checks,
    blockers: readiness.blockers,
    complianceGuidance: guidance,
  };
}
