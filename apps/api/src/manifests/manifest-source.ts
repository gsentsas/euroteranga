import type { DatabaseTransaction } from '@euroteranga/database';
import {
  buildManifestSnapshot,
  type ManifestPassengerSnapshot,
  type PassengerManifestSnapshot,
} from './manifest-rules.js';

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Rebuilds the current PR-15 canonical source from live server data.
 * Returns null only when the trip/source cannot form a valid manifest.
 * PR-17 reuses this exact function to prove whether the latest stored
 * manifest still represents the present checked-in/boarded population.
 */
export async function currentManifestSnapshot(
  db: DatabaseTransaction,
  tripId: string,
): Promise<PassengerManifestSnapshot | null> {
  const trip = await db.trip.findUnique({
    where: { id: tripId },
    select: {
      id: true,
      reference: true,
      plannedDepartureAt: true,
      plannedArrivalAt: true,
      vehicle: { select: { code: true, registrationPlate: true } },
    },
  });
  if (!trip?.plannedDepartureAt || !trip.plannedArrivalAt) return null;

  const checkIns = await db.passengerCheckIn.findMany({
    where: { bookingPassenger: { booking: { tripId: trip.id } } },
    select: {
      reference: true,
      checkedInAt: true,
      bookingPassenger: {
        select: {
          passenger: {
            select: {
              reference: true,
              givenName: true,
              familyName: true,
              dateOfBirth: true,
              nationalityCountry: { select: { iso2: true, iso3: true } },
            },
          },
          booking: {
            select: {
              reference: true,
              originSequence: true,
              destinationSequence: true,
              originRouteWaypoint: {
                select: {
                  sequence: true,
                  stop: {
                    select: {
                      code: true,
                      name: true,
                      country: { select: { iso2: true } },
                    },
                  },
                },
              },
              destinationRouteWaypoint: {
                select: {
                  sequence: true,
                  stop: {
                    select: {
                      code: true,
                      name: true,
                      country: { select: { iso2: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      seatAssignment: {
        select: {
          bookingSeat: { select: { seatMapCell: { select: { seatLabel: true } } } },
        },
      },
      boarding: { select: { reference: true, boardedAt: true } },
    },
  });

  const passengers: ManifestPassengerSnapshot[] = [];
  for (const checkIn of checkIns) {
    const { booking, passenger } = checkIn.bookingPassenger;
    const origin = booking.originRouteWaypoint.stop;
    const destination = booking.destinationRouteWaypoint.stop;
    const seatLabel = checkIn.seatAssignment.bookingSeat.seatMapCell.seatLabel;
    if (!origin || !destination || !seatLabel) return null;
    passengers.push({
      bookingReference: booking.reference,
      passengerReference: passenger.reference,
      givenName: passenger.givenName,
      familyName: passenger.familyName,
      dateOfBirth: isoDate(passenger.dateOfBirth),
      nationality: passenger.nationalityCountry,
      origin: {
        sequence: booking.originSequence,
        code: origin.code,
        name: origin.name,
        countryIso2: origin.country.iso2,
      },
      destination: {
        sequence: booking.destinationSequence,
        code: destination.code,
        name: destination.name,
        countryIso2: destination.country.iso2,
      },
      seat: { label: seatLabel },
      checkIn: {
        reference: checkIn.reference,
        checkedInAt: checkIn.checkedInAt.toISOString(),
      },
      boarding: checkIn.boarding
        ? {
            reference: checkIn.boarding.reference,
            boardedAt: checkIn.boarding.boardedAt.toISOString(),
          }
        : null,
    });
  }

  return buildManifestSnapshot({
    trip: {
      reference: trip.reference,
      plannedDepartureAt: trip.plannedDepartureAt.toISOString(),
      plannedArrivalAt: trip.plannedArrivalAt.toISOString(),
      vehicle: {
        code: trip.vehicle?.code ?? null,
        registrationPlate: trip.vehicle?.registrationPlate ?? null,
      },
    },
    passengers,
  });
}
