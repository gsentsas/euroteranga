import { PublicApiError } from '../auth/http/public-api-error.js';
import type { DepartureBlocker } from './departure-readiness-rules.js';

export class DepartureBlockedError extends PublicApiError {
  override readonly publicDetails: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, blockers: DepartureBlocker[]) {
    super(409, code, message);
    this.publicDetails = { blockers };
  }
}

export const DepartureReadinessErrors = {
  tripNotFound: () => new PublicApiError(404, 'DEPARTURE_TRIP_NOT_FOUND', 'Voyage introuvable.'),
  tripNotScheduled: () =>
    new PublicApiError(
      409,
      'DEPARTURE_TRIP_NOT_SCHEDULED',
      'Cette opération exige un voyage programmé.',
    ),
  tripNotInProgress: () =>
    new PublicApiError(
      409,
      'DEPARTURE_TRIP_NOT_IN_PROGRESS',
      'Seul un voyage en cours peut être clôturé.',
    ),
  readinessBlocked: (blockers: DepartureBlocker[]) =>
    new DepartureBlockedError(
      'DEPARTURE_NOT_READY',
      'Le départ est bloqué tant que des contrôles restent à régulariser.',
      blockers,
    ),
  policyCountryNotFound: () =>
    new PublicApiError(
      422,
      'DEPARTURE_POLICY_COUNTRY_NOT_FOUND',
      'Un pays demandé dans la politique est introuvable.',
    ),
  policyDuplicateRequirement: () =>
    new PublicApiError(
      422,
      'DEPARTURE_POLICY_DUPLICATE_REQUIREMENT',
      'Une exigence de permis est déclarée plusieurs fois.',
    ),
  authorizationMissing: () =>
    new PublicApiError(
      409,
      'DEPARTURE_AUTHORIZATION_MISSING',
      'Le départ doit être explicitement autorisé avant son enregistrement.',
    ),
  authorizationStale: () =>
    new PublicApiError(
      409,
      'DEPARTURE_AUTHORIZATION_STALE',
      'Les faits opérationnels ont changé depuis l’autorisation. Autorisez de nouveau le départ.',
    ),
  concurrencyConflict: () =>
    new PublicApiError(
      409,
      'DEPARTURE_CONCURRENCY_CONFLICT',
      'Les faits du voyage ont changé simultanément. Rechargez puis réessayez.',
    ),
};
