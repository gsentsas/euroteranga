import { PublicApiError } from '../auth/http/public-api-error.js';

/** The vehicle already serves another trip whose planned window overlaps. */
export class TripVehicleOverlapError extends PublicApiError {
  override readonly publicDetails: Readonly<Record<string, unknown>>;

  constructor(conflictingTripReference: string) {
    super(
      409,
      'TRIP_VEHICLE_OVERLAP',
      `Ce véhicule est déjà affecté au voyage ${conflictingTripReference} sur une période qui se chevauche.`,
    );
    this.publicDetails = { conflictingTripReference };
  }
}

export const TripErrors = {
  tripNotFound: () => new PublicApiError(404, 'TRIP_NOT_FOUND', 'Voyage introuvable.'),
  routeVersionNotFound: () =>
    new PublicApiError(404, 'ROUTE_VERSION_NOT_FOUND', 'Version de route introuvable.'),
  routeVersionNotPublished: () =>
    new PublicApiError(
      422,
      'TRIP_ROUTE_VERSION_NOT_PUBLISHED',
      "Un voyage ne peut utiliser qu'une version de route publiée.",
    ),
  routeVersionRetired: () =>
    new PublicApiError(
      422,
      'TRIP_ROUTE_VERSION_RETIRED',
      'Cette version de route est retirée : planifiez sur la version publiée en vigueur.',
    ),
  referenceConflict: () =>
    new PublicApiError(409, 'TRIP_REFERENCE_CONFLICT', 'Cette référence de voyage existe déjà.'),
  vehicleNotFound: () => new PublicApiError(404, 'VEHICLE_NOT_FOUND', 'Véhicule introuvable.'),
  vehicleOverlap: (conflictingTripReference: string) =>
    new TripVehicleOverlapError(conflictingTripReference),
  vehicleUnavailable: () =>
    new PublicApiError(
      422,
      'TRIP_VEHICLE_UNAVAILABLE',
      'Seul un véhicule en service (ACTIVE) peut être affecté ou planifié.',
    ),
  notDraft: () =>
    new PublicApiError(
      409,
      'TRIP_NOT_DRAFT',
      "Le voyage n'est plus un brouillon : son horaire est figé.",
    ),
  cancelled: () =>
    new PublicApiError(409, 'TRIP_CANCELLED', 'Un voyage annulé ne peut plus être modifié.'),
  dispatchStarted: () =>
    new PublicApiError(
      409,
      'TRIP_DISPATCH_STARTED',
      'Le voyage a déjà commencé : son exploitation est désormais figée.',
    ),
  statusConflict: () =>
    new PublicApiError(
      409,
      'TRIP_STATUS_CONFLICT',
      'Le statut du voyage a changé entre-temps. Rechargez la fiche.',
    ),
  vehicleConflict: () =>
    new PublicApiError(
      409,
      'TRIP_VEHICLE_CONFLICT',
      'Le véhicule affecté a changé entre-temps. Rechargez la fiche.',
    ),
  supportVehicleConflict: () =>
    new PublicApiError(
      409,
      'TRIP_SUPPORT_VEHICLE_CONFLICT',
      "Le véhicule d'appoint a changé entre-temps. Rechargez la fiche.",
    ),
  primaryVehicleRoleInvalid: () =>
    new PublicApiError(
      422,
      'TRIP_PRIMARY_VEHICLE_ROLE_INVALID',
      "Un véhicule CARGO_SUPPORT ne peut pas être l'autocar principal du voyage.",
    ),
  supportVehicleRoleInvalid: () =>
    new PublicApiError(
      422,
      'TRIP_SUPPORT_VEHICLE_ROLE_INVALID',
      "Le véhicule d'appoint doit avoir le rôle CARGO_SUPPORT.",
    ),
  supportVehicleCapacityMissing: () =>
    new PublicApiError(
      422,
      'TRIP_SUPPORT_VEHICLE_CAPACITY_MISSING',
      "Le véhicule d'appoint doit avoir une charge utile et un volume configurés.",
    ),
  supportVehicleSameAsPrimary: () =>
    new PublicApiError(
      422,
      'TRIP_SUPPORT_VEHICLE_SAME_AS_PRIMARY',
      "Le véhicule d'appoint doit être différent du véhicule principal.",
    ),
  cargoAssignmentConflict: () =>
    new PublicApiError(
      409,
      'TRIP_CARGO_ASSIGNMENT_CONFLICT',
      'Du fret actif est affecté à ce véhicule. Réaffectez ou terminez ce fret avant de modifier le convoi.',
    ),
  seatMapConflict: () =>
    new PublicApiError(
      409,
      'TRIP_SEAT_MAP_CONFLICT',
      'Le plan de sièges du voyage a changé entre-temps. Rechargez la fiche.',
    ),
  seatMapIncompatible: () =>
    new PublicApiError(
      422,
      'TRIP_SEAT_MAP_INCOMPATIBLE',
      'Le plan de sièges du véhicule ne correspond pas à celui du voyage.',
    ),
  fareTableConflict: () =>
    new PublicApiError(
      409,
      'TRIP_FARE_TABLE_CONFLICT',
      'La grille tarifaire du voyage a changé entre-temps. Rechargez la fiche.',
    ),
  fareTableIncompatible: () =>
    new PublicApiError(
      422,
      'TRIP_FARE_TABLE_INCOMPATIBLE',
      'Cette grille tarifaire ne porte pas sur la version de route du voyage.',
    ),
  reasonRequired: () =>
    new PublicApiError(
      422,
      'TRIP_REASON_REQUIRED',
      "Un motif est obligatoire pour changer le véhicule d'un voyage planifié.",
    ),
  timetableInvalid: (message: string) => new PublicApiError(422, 'TRIP_TIMETABLE_INVALID', message),
  costPlanLocked: () =>
    new PublicApiError(
      409,
      'TRIP_COST_LOCKED',
      'Le chiffrage de ce voyage est verrouillé et ne peut plus être modifié.',
    ),
  hasConfirmedBookings: () =>
    new PublicApiError(
      409,
      'TRIP_HAS_CONFIRMED_BOOKINGS',
      'Ce voyage a des réservations confirmées (payées) : il ne peut pas être annulé tant que le remboursement n’existe pas.',
    ),
};
