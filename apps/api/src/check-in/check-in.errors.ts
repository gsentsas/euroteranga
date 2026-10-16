import { PublicApiError } from '../auth/http/public-api-error.js';
import type { Blocker } from './check-in-rules.js';

/** 409 whose body lists the stable blockers: { details: { blockers } }. */
export class CheckInBlockedError extends PublicApiError {
  override readonly publicDetails: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    readonly blockers: Blocker[],
  ) {
    super(409, code, message);
    this.publicDetails = { blockers };
  }
}

export const CheckInErrors = {
  subjectNotFound: () =>
    new PublicApiError(404, 'CHECK_IN_SUBJECT_NOT_FOUND', 'Voyageur de réservation introuvable.'),
  checkInNotFound: () =>
    new PublicApiError(404, 'CHECK_IN_NOT_FOUND', 'Enregistrement introuvable.'),
  seatNotFound: () =>
    new PublicApiError(404, 'SEAT_NOT_FOUND', 'Ce siège ne fait pas partie de la réservation.'),
  seatAlreadyAssigned: () =>
    new PublicApiError(
      409,
      'SEAT_ALREADY_ASSIGNED',
      'Ce siège est déjà attribué à un autre voyageur de la réservation.',
    ),
  seatLocked: () =>
    new PublicApiError(
      409,
      'SEAT_ASSIGNMENT_LOCKED',
      'Le siège d’un voyageur enregistré ne peut plus être modifié.',
    ),
  notEligible: (blockers: Blocker[]) =>
    new CheckInBlockedError(
      'CHECK_IN_NOT_READY',
      'Le check-in n’est pas possible tant que des points restent à régulariser.',
      blockers,
    ),
  qrInvalid: () =>
    new PublicApiError(
      422,
      'BOARDING_QR_INVALID',
      'Code d’embarquement invalide ou version non prise en charge.',
    ),
  credentialNotFound: () =>
    new PublicApiError(404, 'BOARDING_CREDENTIAL_NOT_FOUND', 'Code d’embarquement inconnu.'),
  stale: (blockers: Blocker[]) =>
    new CheckInBlockedError(
      'CHECK_IN_STALE',
      'L’enregistrement n’est plus valable : un point bloquant est apparu depuis le check-in.',
      blockers,
    ),
  alreadyBoarded: () =>
    new PublicApiError(409, 'PASSENGER_ALREADY_BOARDED', 'Ce voyageur est déjà embarqué.'),
  idempotencyConflict: () =>
    new PublicApiError(
      409,
      'BOARDING_CLIENT_EVENT_ID_REUSED',
      'Cet identifiant d’événement a déjà été utilisé avec un autre contenu.',
    ),
  invalidTimestamp: () =>
    new PublicApiError(
      422,
      'BOARDING_TIME_INVALID',
      'L’heure d’embarquement est hors de la fenêtre autorisée.',
    ),
  crewContextStale: () =>
    new PublicApiError(
      409,
      'CREW_CONTEXT_STALE',
      'L’appareil ou l’affectation équipage n’est plus autorisé pour ce voyage.',
    ),
};
