import { PublicApiError } from '../auth/http/public-api-error.js';

export const BorderErrors = {
  tripNotFound: () => new PublicApiError(404, 'BORDER_TRIP_NOT_FOUND', 'Voyage introuvable.'),
  tripUnavailable: () =>
    new PublicApiError(
      409,
      'BORDER_TRIP_UNAVAILABLE',
      'Le voyage doit être en cours pour enregistrer un passage frontière.',
    ),
  waypointInvalid: () =>
    new PublicApiError(
      422,
      'BORDER_WAYPOINT_INVALID',
      'Le point sélectionné n’est pas une frontière de la route de ce voyage.',
    ),
  timestampInvalid: () =>
    new PublicApiError(
      422,
      'BORDER_TIMESTAMP_INVALID',
      'La date de l’événement est trop éloignée dans le futur.',
    ),
  transitionInvalid: () =>
    new PublicApiError(
      409,
      'BORDER_TRANSITION_INVALID',
      'La transition de passage frontière n’est pas valide.',
    ),
  idempotencyConflict: () =>
    new PublicApiError(
      409,
      'BORDER_CLIENT_EVENT_ID_REUSED',
      'Cet identifiant d’événement a déjà été utilisé avec un autre contenu.',
    ),
  crewUnavailable: () =>
    new PublicApiError(
      403,
      'BORDER_CREW_NOT_ASSIGNED',
      'Ce voyage n’est pas actuellement affecté à cet équipage.',
    ),
  crewDeviceUnavailable: () =>
    new PublicApiError(
      403,
      'BORDER_CREW_DEVICE_UNAVAILABLE',
      'Le dispositif Crew n’est pas autorisé.',
    ),
};
