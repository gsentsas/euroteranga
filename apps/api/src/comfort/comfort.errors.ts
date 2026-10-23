import { PublicApiError } from '../auth/http/public-api-error.js';

export const ComfortErrors = {
  tripNotFound: () => new PublicApiError(404, 'COMFORT_TRIP_NOT_FOUND', 'Voyage introuvable.'),
  bookingNotFound: () =>
    new PublicApiError(404, 'COMFORT_BOOKING_NOT_FOUND', 'Réservation introuvable.'),
  tripUnavailable: () =>
    new PublicApiError(
      409,
      'COMFORT_TRIP_UNAVAILABLE',
      'Le voyage ne permet pas cet événement de confort.',
    ),
  waypointInvalid: () =>
    new PublicApiError(
      422,
      'COMFORT_WAYPOINT_INVALID',
      'Cette étape n’appartient pas à la route de ce voyage.',
    ),
  timestampInvalid: () =>
    new PublicApiError(
      422,
      'COMFORT_TIMESTAMP_INVALID',
      'La date de l’événement est trop éloignée dans le futur.',
    ),
  transitionInvalid: () =>
    new PublicApiError(
      409,
      'COMFORT_TRANSITION_INVALID',
      'Le statut de cette étape ne permet pas cette transition.',
    ),
  idempotencyConflict: () =>
    new PublicApiError(
      409,
      'COMFORT_CLIENT_EVENT_ID_REUSED',
      'Cet identifiant d’événement a déjà été utilisé avec un autre contenu.',
    ),
};
