import { PublicApiError } from '../auth/http/public-api-error.js';

export const CrewErrors = {
  deviceConflict: () =>
    new PublicApiError(
      409,
      'CREW_DEVICE_CONFLICT',
      'Cet appareil appartient déjà à une autre identité.',
    ),
  deviceNotFound: () =>
    new PublicApiError(404, 'CREW_DEVICE_NOT_FOUND', 'Appareil équipage introuvable.'),
  deviceUnavailable: () =>
    new PublicApiError(
      409,
      'CREW_DEVICE_UNAVAILABLE',
      'Cet appareil doit être ré-enrôlé avant synchronisation.',
    ),
  assignmentNotFound: () =>
    new PublicApiError(404, 'CREW_ASSIGNMENT_NOT_FOUND', 'Affectation équipage introuvable.'),
  notAssigned: () =>
    new PublicApiError(403, 'CREW_TRIP_NOT_ASSIGNED', 'Vous n’êtes pas affecté à ce voyage.'),
  identityUnavailable: () =>
    new PublicApiError(
      422,
      'CREW_IDENTITY_UNAVAILABLE',
      'Cette identité équipage n’est pas active.',
    ),
  tripUnavailable: () =>
    new PublicApiError(
      409,
      'CREW_TRIP_UNAVAILABLE',
      'Ce voyage n’est pas disponible pour une affectation équipage.',
    ),
  assignmentConflict: () =>
    new PublicApiError(409, 'CREW_ASSIGNMENT_CONFLICT', 'Une affectation active existe déjà.'),
  assignmentExpiryInvalid: () =>
    new PublicApiError(
      422,
      'CREW_ASSIGNMENT_EXPIRY_INVALID',
      'L’expiration de l’affectation doit être future.',
    ),
};
