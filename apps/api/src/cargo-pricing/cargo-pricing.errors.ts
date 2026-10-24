import { PublicApiError } from '../auth/http/public-api-error.js';

export const CargoPricingErrors = {
  ruleNotFound: () =>
    new PublicApiError(404, 'CARGO_PRICING_RULE_NOT_FOUND', 'Règle tarifaire fret introuvable.'),
  versionNotFound: () =>
    new PublicApiError(
      404,
      'CARGO_PRICING_VERSION_NOT_FOUND',
      'Version tarifaire fret introuvable.',
    ),
  codeConflict: () =>
    new PublicApiError(
      409,
      'CARGO_PRICING_RULE_CODE_CONFLICT',
      'Ce code de règle tarifaire existe déjà.',
    ),
  draftExists: () =>
    new PublicApiError(
      409,
      'CARGO_PRICING_DRAFT_ALREADY_EXISTS',
      'Cette règle possède déjà une version brouillon.',
    ),
  versionNotDraft: () =>
    new PublicApiError(
      409,
      'CARGO_PRICING_VERSION_NOT_DRAFT',
      'Seule une version brouillon peut être modifiée ou activée.',
    ),
  versionNotActive: () =>
    new PublicApiError(
      409,
      'CARGO_PRICING_VERSION_NOT_ACTIVE',
      'Seule une version active peut être désactivée.',
    ),
  invalidConfiguration: (message = 'La configuration tarifaire fret est incomplète.') =>
    new PublicApiError(422, 'CARGO_PRICING_CONFIGURATION_INVALID', message),
  expiredVersion: () =>
    new PublicApiError(
      422,
      'CARGO_PRICING_VERSION_EXPIRED',
      'Une version déjà expirée ne peut pas être activée.',
    ),
  futureVersion: () =>
    new PublicApiError(
      422,
      'CARGO_PRICING_VERSION_NOT_EFFECTIVE',
      'Une version dont la date d’effet est future ne peut pas être activée.',
    ),
} as const;
