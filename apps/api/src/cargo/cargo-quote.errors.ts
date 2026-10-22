import { PublicApiError } from '../auth/http/public-api-error.js';

export const CargoQuoteErrors = {
  notFound: () => new PublicApiError(404, 'CARGO_QUOTE_NOT_FOUND', 'Devis fret introuvable.'),
  draftExists: () =>
    new PublicApiError(
      409,
      'CARGO_QUOTE_DRAFT_EXISTS',
      'Un brouillon de devis existe déjà pour ce fret.',
    ),
  referenceConflict: () =>
    new PublicApiError(409, 'CARGO_QUOTE_REFERENCE_CONFLICT', 'Référence de devis déjà utilisée.'),
  conflict: () =>
    new PublicApiError(
      409,
      'CARGO_QUOTE_CONFLICT',
      'Le devis a été modifié depuis l’ouverture de la fiche.',
    ),
  frozen: () =>
    new PublicApiError(409, 'CARGO_QUOTE_FROZEN', 'Ce devis n’est plus modifiable.'),
  invalidTransition: () =>
    new PublicApiError(
      409,
      'CARGO_QUOTE_INVALID_TRANSITION',
      'Cette transition du devis n’est pas autorisée.',
    ),
  acceptedBlocksIssue: () =>
    new PublicApiError(
      409,
      'CARGO_QUOTE_ACCEPTED_BLOCKS_ISSUE',
      'Un devis accepté existe déjà pour ce fret.',
    ),
  negativeTotal: () =>
    new PublicApiError(
      422,
      'CARGO_QUOTE_TOTAL_NEGATIVE',
      'Les remises ne peuvent pas dépasser les frais du devis.',
    ),
  invalidLines: () =>
    new PublicApiError(
      422,
      'CARGO_QUOTE_LINES_INVALID',
      'Le devis doit contenir des lignes ordonnées valides.',
    ),
};
