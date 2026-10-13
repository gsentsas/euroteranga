import { PublicApiError } from '../auth/http/public-api-error.js';

export const NetworkErrors = {
  countryNotFound: () => new PublicApiError(404, 'COUNTRY_NOT_FOUND', 'Pays introuvable.'),
  stopNotFound: () => new PublicApiError(404, 'STOP_NOT_FOUND', 'Arrêt introuvable.'),
  checkpointNotFound: () =>
    new PublicApiError(404, 'CHECKPOINT_NOT_FOUND', 'Point de passage introuvable.'),
  routeNotFound: () => new PublicApiError(404, 'ROUTE_NOT_FOUND', 'Route introuvable.'),
  routeVersionNotFound: () =>
    new PublicApiError(404, 'ROUTE_VERSION_NOT_FOUND', 'Version de route introuvable.'),
  duplicateIdentifier: () =>
    new PublicApiError(409, 'NETWORK_IDENTIFIER_CONFLICT', 'Cet identifiant existe déjà.'),
  invalidReference: () =>
    new PublicApiError(422, 'NETWORK_REFERENCE_INVALID', 'Une référence réseau est invalide.'),
  invariantViolation: () =>
    new PublicApiError(422, 'NETWORK_INVARIANT_VIOLATION', 'Les données réseau sont invalides.'),
  draftAlreadyExists: () =>
    new PublicApiError(409, 'ROUTE_DRAFT_ALREADY_EXISTS', 'Cette route possède déjà un brouillon.'),
  versionNotDraft: () =>
    new PublicApiError(409, 'ROUTE_VERSION_NOT_DRAFT', "La version n'est plus modifiable."),
  versionNotPublishable: () =>
    new PublicApiError(
      422,
      'ROUTE_VERSION_NOT_PUBLISHABLE',
      'La version de route ne satisfait pas les conditions de publication.',
    ),
  publicationConflict: () =>
    new PublicApiError(409, 'ROUTE_PUBLICATION_CONFLICT', 'La publication est déjà terminée.'),
};
