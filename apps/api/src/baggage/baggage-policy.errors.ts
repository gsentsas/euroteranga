import { PublicApiError } from '../auth/http/public-api-error.js';

export const BaggagePolicyErrors = {
  notFound: () =>
    new PublicApiError(404, 'BAGGAGE_POLICY_NOT_FOUND', 'Politique bagage introuvable.'),
  versionNotFound: () =>
    new PublicApiError(
      404,
      'BAGGAGE_POLICY_VERSION_NOT_FOUND',
      'Version de politique bagage introuvable.',
    ),
  fareVersionNotFound: () =>
    new PublicApiError(
      404,
      'FARE_TABLE_VERSION_NOT_FOUND',
      'Version de grille tarifaire introuvable.',
    ),
  codeConflict: () =>
    new PublicApiError(409, 'BAGGAGE_POLICY_CODE_CONFLICT', 'Ce code de politique existe déjà.'),
  draftAlreadyExists: () =>
    new PublicApiError(
      409,
      'BAGGAGE_POLICY_DRAFT_ALREADY_EXISTS',
      'Cette politique possède déjà un brouillon.',
    ),
  fareVersionConflict: () =>
    new PublicApiError(
      409,
      'BAGGAGE_POLICY_FARE_VERSION_CONFLICT',
      'Cette version tarifaire possède déjà une politique bagage.',
    ),
  versionNotDraft: () =>
    new PublicApiError(
      409,
      'BAGGAGE_POLICY_VERSION_NOT_DRAFT',
      "Cette version n'est plus modifiable.",
    ),
  currencyMismatch: () =>
    new PublicApiError(
      422,
      'BAGGAGE_POLICY_CURRENCY_MISMATCH',
      'La devise de la politique doit correspondre à celle de la grille tarifaire.',
    ),
  notPublishable: (message: string) =>
    new PublicApiError(422, 'BAGGAGE_POLICY_VERSION_NOT_PUBLISHABLE', message),
};
