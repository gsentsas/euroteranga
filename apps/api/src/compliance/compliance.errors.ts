import { PublicApiError } from '../auth/http/public-api-error.js';
import type { RuleIssue } from './rule-language.js';

export const ComplianceErrors = {
  ruleNotFound: () =>
    new PublicApiError(404, 'COMPLIANCE_RULE_NOT_FOUND', 'Règle de conformité introuvable.'),
  versionNotFound: () =>
    new PublicApiError(404, 'COMPLIANCE_RULE_VERSION_NOT_FOUND', 'Version de règle introuvable.'),
  definitionInvalid: (issues: RuleIssue[]) =>
    new PublicApiError(
      422,
      'COMPLIANCE_RULE_DEFINITION_INVALID',
      `Définition de règle invalide : ${issues
        .slice(0, 5)
        .map((issue) => `${issue.path || '/'} (${issue.code})`)
        .join(', ')}.`,
    ),
  countryUnknown: (codes: string[]) =>
    new PublicApiError(
      422,
      'COMPLIANCE_RULE_COUNTRY_UNKNOWN',
      `Pays inconnu dans la règle : ${codes.slice(0, 10).join(', ')}.`,
    ),
  versionNotDraft: () =>
    new PublicApiError(
      409,
      'COMPLIANCE_RULE_VERSION_NOT_DRAFT',
      'Seul un brouillon peut être modifié, vérifié ou publié. Créez une nouvelle version.',
    ),
  draftExists: () =>
    new PublicApiError(
      409,
      'COMPLIANCE_RULE_DRAFT_EXISTS',
      'Un brouillon existe déjà pour cette règle.',
    ),
  contentChanged: () =>
    new PublicApiError(
      409,
      'COMPLIANCE_RULE_CONTENT_CHANGED',
      'Le brouillon a changé depuis votre lecture. Rechargez-le avant de continuer.',
    ),
  notVerified: () =>
    new PublicApiError(
      422,
      'COMPLIANCE_RULE_NOT_VERIFIED',
      'Une version non vérifiée ne peut pas être publiée.',
    ),
  sourceIncomplete: () =>
    new PublicApiError(
      422,
      'COMPLIANCE_RULE_SOURCE_INCOMPLETE',
      'La source doit indiquer une autorité, un titre et une URL ou une référence officielle.',
    ),
  sourceCheckedInFuture: () =>
    new PublicApiError(
      422,
      'COMPLIANCE_RULE_SOURCE_DATE_INVALID',
      'La date de vérification de la source ne peut pas être dans le futur.',
    ),
  versionNotPublished: () =>
    new PublicApiError(
      409,
      'COMPLIANCE_RULE_VERSION_NOT_PUBLISHED',
      'Seule une version publiée peut être retirée.',
    ),
  /** Same answer for a foreign and an unknown booking or passenger. */
  subjectNotFound: () =>
    new PublicApiError(404, 'COMPLIANCE_SUBJECT_NOT_FOUND', 'Voyageur ou réservation introuvable.'),
  bookingNotFound: () => new PublicApiError(404, 'BOOKING_NOT_FOUND', 'Réservation introuvable.'),
  evaluationNotFound: () =>
    new PublicApiError(404, 'COMPLIANCE_EVALUATION_NOT_FOUND', 'Évaluation introuvable.'),
  contextIncomplete: () =>
    new PublicApiError(
      409,
      'COMPLIANCE_CONTEXT_INCOMPLETE',
      'Le voyage n’a pas encore d’horaires complets : évaluation impossible.',
    ),
  evaluationStale: () =>
    new PublicApiError(
      409,
      'COMPLIANCE_EVALUATION_STALE',
      'Les informations ou les règles ont changé depuis cette évaluation. Réévaluez avant de décider.',
    ),
  evaluationSuperseded: () =>
    new PublicApiError(
      409,
      'COMPLIANCE_EVALUATION_SUPERSEDED',
      'Une évaluation plus récente existe pour ce voyageur.',
    ),
  reviewConflict: () =>
    new PublicApiError(
      409,
      'COMPLIANCE_REVIEW_CONFLICT',
      'Une autre revue a été enregistrée entre-temps. Rechargez le dossier.',
    ),
};
