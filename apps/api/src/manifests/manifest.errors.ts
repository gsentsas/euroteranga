import { PublicApiError } from '../auth/http/public-api-error.js';

export const ManifestErrors = {
  notFound: () => new PublicApiError(404, 'MANIFEST_NOT_FOUND', 'Manifeste introuvable.'),
  tripNotFound: () => new PublicApiError(404, 'MANIFEST_TRIP_NOT_FOUND', 'Voyage introuvable.'),
  tripNotScheduled: () =>
    new PublicApiError(
      409,
      'MANIFEST_TRIP_NOT_SCHEDULED',
      'Un manifeste ne peut être généré que pour un voyage programmé.',
    ),
  sourceInvalid: () =>
    new PublicApiError(
      409,
      'MANIFEST_SOURCE_INVALID',
      'Les faits du voyage ne permettent pas de construire un manifeste.',
    ),
};
