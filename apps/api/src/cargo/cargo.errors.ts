import { PublicApiError } from '../auth/http/public-api-error.js';

export const CargoErrors = {
  notFound: () => new PublicApiError(404, 'CARGO_NOT_FOUND', 'Colis ou fret introuvable.'),
  bookingNotFound: () =>
    new PublicApiError(404, 'CARGO_BOOKING_NOT_FOUND', 'Réservation associée introuvable.'),
  customerNotFound: () =>
    new PublicApiError(404, 'CARGO_CUSTOMER_NOT_FOUND', 'Client associé introuvable.'),
  customerMismatch: () =>
    new PublicApiError(
      409,
      'CARGO_CUSTOMER_MISMATCH',
      'Le client associé ne correspond pas au client de la réservation.',
    ),
  assignmentTargetNotFound: () =>
    new PublicApiError(404, 'CARGO_ASSIGNMENT_TARGET_NOT_FOUND', 'Voyage ou véhicule introuvable.'),
  invalidTransition: () =>
    new PublicApiError(
      409,
      'CARGO_INVALID_TRANSITION',
      'Cette transition du colis ou fret n’est pas autorisée.',
    ),
  assignmentInvalid: () =>
    new PublicApiError(
      409,
      'CARGO_ASSIGNMENT_INVALID',
      'Cette affectation voyage/véhicule n’est pas autorisée.',
    ),
  capacityExceeded: () =>
    new PublicApiError(
      409,
      'CARGO_CAPACITY_EXCEEDED',
      'La capacité de charge ou de volume du véhicule serait dépassée.',
    ),
  frozen: () =>
    new PublicApiError(
      409,
      'CARGO_DETAILS_FROZEN',
      'Les caractéristiques du fret sont figées après chargement.',
    ),
  conflict: () =>
    new PublicApiError(
      409,
      'CARGO_CONFLICT',
      'Le colis ou fret a été modifié depuis l’ouverture de la fiche.',
    ),
  invalidTimestamp: () =>
    new PublicApiError(
      422,
      'CARGO_EVENT_TIME_INVALID',
      'La date de l’événement est hors de la fenêtre autorisée.',
    ),
  invalidLocation: () =>
    new PublicApiError(
      422,
      'CARGO_EVENT_LOCATION_INVALID',
      'Le point opérationnel ne fait pas partie du trajet affecté.',
    ),
  idempotencyConflict: () =>
    new PublicApiError(
      409,
      'CARGO_CLIENT_EVENT_ID_REUSED',
      'Cet identifiant d’événement a déjà été utilisé avec un autre contenu.',
    ),
  referenceConflict: () =>
    new PublicApiError(409, 'CARGO_REFERENCE_CONFLICT', 'Référence fret déjà utilisée.'),
};
