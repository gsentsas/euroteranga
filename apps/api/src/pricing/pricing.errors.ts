import { PublicApiError } from '../auth/http/public-api-error.js';

export const PricingErrors = {
  fareTableNotFound: () =>
    new PublicApiError(404, 'FARE_TABLE_NOT_FOUND', 'Grille tarifaire introuvable.'),
  routeNotFound: () => new PublicApiError(404, 'ROUTE_NOT_FOUND', 'Route introuvable.'),
  routeVersionNotFound: () =>
    new PublicApiError(404, 'ROUTE_VERSION_NOT_FOUND', 'Version de route introuvable.'),
  versionNotFound: () =>
    new PublicApiError(
      404,
      'FARE_TABLE_VERSION_NOT_FOUND',
      'Version de grille tarifaire introuvable.',
    ),
  codeConflict: () =>
    new PublicApiError(409, 'FARE_TABLE_CODE_CONFLICT', 'Ce code de grille tarifaire existe déjà.'),
  draftAlreadyExists: () =>
    new PublicApiError(
      409,
      'FARE_TABLE_DRAFT_ALREADY_EXISTS',
      'Cette grille tarifaire possède déjà un brouillon.',
    ),
  versionNotDraft: () =>
    new PublicApiError(409, 'FARE_TABLE_VERSION_NOT_DRAFT', "La version n'est plus modifiable."),
  routeMismatch: () =>
    new PublicApiError(
      422,
      'FARE_TABLE_ROUTE_MISMATCH',
      "Cette version de route n'appartient pas à la route de la grille tarifaire.",
    ),
  routeVersionNotPublished: () =>
    new PublicApiError(
      422,
      'FARE_TABLE_ROUTE_VERSION_NOT_PUBLISHED',
      'Seule une version de route déjà publiée peut être tarifée.',
    ),
  entriesInvalid: (message: string) => new PublicApiError(422, 'FARE_ENTRIES_INVALID', message),
  notPublishable: (message: string) =>
    new PublicApiError(422, 'FARE_TABLE_VERSION_NOT_PUBLISHABLE', message),
  versionNotPublished: () =>
    new PublicApiError(
      422,
      'FARE_TABLE_VERSION_NOT_PUBLISHED',
      "Seule une version publiée d'une grille tarifaire peut être affectée.",
    ),
  versionRetired: () =>
    new PublicApiError(
      422,
      'FARE_TABLE_VERSION_RETIRED',
      'Cette version est retirée : affectez la version publiée en vigueur.',
    ),
  fareTableInactive: () =>
    new PublicApiError(422, 'FARE_TABLE_INACTIVE', 'Cette grille tarifaire est désactivée.'),
  tripNotFound: () => new PublicApiError(404, 'TRIP_NOT_FOUND', 'Voyage introuvable.'),
  tripPricingNotConfigured: () =>
    new PublicApiError(
      422,
      'TRIP_PRICING_NOT_CONFIGURED',
      "Aucune grille tarifaire n'est affectée à ce voyage.",
    ),
  fareNotConfigured: () =>
    new PublicApiError(
      404,
      'FARE_NOT_CONFIGURED',
      "Aucun tarif de base n'est configuré pour cette origine et cette destination.",
    ),
  fareWaypointInvalid: () =>
    new PublicApiError(
      422,
      'FARE_WAYPOINT_INVALID',
      "L'origine doit être un arrêt de montée et la destination un arrêt de descente ultérieur de la route du voyage.",
    ),
};
