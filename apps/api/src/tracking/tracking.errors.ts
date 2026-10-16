import { PublicApiError } from '../auth/http/public-api-error.js';

export const TrackingErrors = {
  tripNotFound: () => new PublicApiError(404, 'TRACKING_TRIP_NOT_FOUND', 'Voyage introuvable.'),
  deviceNotFound: () =>
    new PublicApiError(404, 'TRACKING_DEVICE_NOT_FOUND', 'Dispositif de suivi introuvable.'),
  deviceConflict: () =>
    new PublicApiError(409, 'TRACKING_DEVICE_CONFLICT', 'Ce dispositif de suivi existe déjà.'),
  deviceMismatch: () =>
    new PublicApiError(
      422,
      'TRACKING_DEVICE_TRIP_MISMATCH',
      'Le dispositif de suivi ne correspond pas au véhicule du voyage.',
    ),
  waypointInvalid: () =>
    new PublicApiError(
      422,
      'TRACKING_WAYPOINT_INVALID',
      'Le checkpoint ne fait pas partie de la route de ce voyage.',
    ),
  crewUnavailable: () =>
    new PublicApiError(
      403,
      'TRACKING_CREW_NOT_ASSIGNED',
      'Ce voyage n’est pas actuellement affecté à cet équipage.',
    ),
  crewDeviceUnavailable: () =>
    new PublicApiError(
      403,
      'TRACKING_CREW_DEVICE_UNAVAILABLE',
      'Le dispositif Crew n’est pas autorisé.',
    ),
  idempotencyConflict: () =>
    new PublicApiError(
      409,
      'TRACKING_CLIENT_EVENT_ID_REUSED',
      'Cet identifiant d’événement a déjà été utilisé avec un autre contenu.',
    ),
  providerEventConflict: () =>
    new PublicApiError(
      409,
      'TRACKING_PROVIDER_EVENT_ID_REUSED',
      'Cet événement provider a déjà été utilisé avec un autre contenu.',
    ),
  tokenNotFound: () =>
    new PublicApiError(404, 'TRACKING_NOT_FOUND', 'Suivi indisponible ou lien invalide.'),
  tokenExpiryInvalid: () =>
    new PublicApiError(
      422,
      'TRACKING_TOKEN_EXPIRY_INVALID',
      'La date d’expiration doit être future.',
    ),
  timestampInvalid: () =>
    new PublicApiError(
      422,
      'TRACKING_TIMESTAMP_INVALID',
      'La date de l’observation est trop éloignée dans le futur.',
    ),
};
