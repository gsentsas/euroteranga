import { PublicApiError } from '../auth/http/public-api-error.js';

export const SeatMapErrors = {
  seatMapNotFound: () =>
    new PublicApiError(404, 'SEAT_MAP_NOT_FOUND', 'Plan de sièges introuvable.'),
  versionNotFound: () =>
    new PublicApiError(404, 'SEAT_MAP_VERSION_NOT_FOUND', 'Version de plan de sièges introuvable.'),
  codeConflict: () =>
    new PublicApiError(409, 'SEAT_MAP_CODE_CONFLICT', 'Ce code de plan de sièges existe déjà.'),
  draftAlreadyExists: () =>
    new PublicApiError(
      409,
      'SEAT_MAP_DRAFT_ALREADY_EXISTS',
      'Ce plan de sièges possède déjà un brouillon.',
    ),
  versionNotDraft: () =>
    new PublicApiError(409, 'SEAT_MAP_VERSION_NOT_DRAFT', "La version n'est plus modifiable."),
  cellsInvalid: (message: string) => new PublicApiError(422, 'SEAT_MAP_CELLS_INVALID', message),
  notPublishable: (message: string) =>
    new PublicApiError(422, 'SEAT_MAP_VERSION_NOT_PUBLISHABLE', message),
  /** Assignment of a DRAFT (never published) version. */
  versionNotPublished: () =>
    new PublicApiError(
      422,
      'SEAT_MAP_VERSION_NOT_PUBLISHED',
      "Seule une version publiée d'un plan de sièges peut être affectée.",
    ),
  /** New assignment of a version retired since. */
  versionRetired: () =>
    new PublicApiError(
      422,
      'SEAT_MAP_VERSION_RETIRED',
      'Cette version est retirée : affectez la version publiée en vigueur.',
    ),
  seatMapInactive: () =>
    new PublicApiError(422, 'SEAT_MAP_INACTIVE', 'Ce plan de sièges est désactivé.'),
};
