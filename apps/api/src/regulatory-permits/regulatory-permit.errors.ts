import { PublicApiError } from '../auth/http/public-api-error.js';

export const RegulatoryPermitErrors = {
  notFound: () =>
    new PublicApiError(
      404,
      'REGULATORY_PERMIT_NOT_FOUND',
      'Autorisation réglementaire introuvable.',
    ),
  scopeNotFound: () =>
    new PublicApiError(
      422,
      'REGULATORY_PERMIT_SCOPE_NOT_FOUND',
      "Le périmètre demandé n'existe pas.",
    ),
  countryNotFound: () =>
    new PublicApiError(
      422,
      'REGULATORY_PERMIT_COUNTRY_NOT_FOUND',
      'Le pays demandé est introuvable.',
    ),
  duplicate: () =>
    new PublicApiError(
      409,
      'REGULATORY_PERMIT_DUPLICATE',
      'Cette autorisation réglementaire existe déjà.',
    ),
  notDraft: () =>
    new PublicApiError(
      409,
      'REGULATORY_PERMIT_NOT_DRAFT',
      'Seul un brouillon peut être modifié ou activé.',
    ),
  notActive: () =>
    new PublicApiError(
      409,
      'REGULATORY_PERMIT_NOT_ACTIVE',
      'Seule une autorisation active peut être révoquée.',
    ),
  revisionConflict: () =>
    new PublicApiError(
      409,
      'REGULATORY_PERMIT_REVISION_CONFLICT',
      "L'autorisation a changé. Rechargez sa fiche.",
    ),
  invalidDates: () =>
    new PublicApiError(
      422,
      'REGULATORY_PERMIT_DATES_INVALID',
      'La période de validité est incohérente.',
    ),
  sourceCheckFuture: () =>
    new PublicApiError(
      422,
      'REGULATORY_PERMIT_SOURCE_DATE_INVALID',
      'La source ne peut pas être vérifiée dans le futur.',
    ),
};
