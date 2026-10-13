import { PublicApiError } from '../auth/http/public-api-error.js';

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
  hasConfirmedBookings: () =>
    new PublicApiError(
      409,
      'TRIP_HAS_CONFIRMED_BOOKINGS',
      'Ce voyage a des réservations confirmées (payées) : il ne peut pas être annulé tant que le remboursement n’existe pas.',
    ),
};
