import { PublicApiError } from '../auth/http/public-api-error.js';

export const BaggageErrors = {
  notFound: () => new PublicApiError(404, 'BAGGAGE_NOT_FOUND', 'Bagage introuvable.'),
  subjectNotFound: () =>
    new PublicApiError(404, 'BAGGAGE_SUBJECT_NOT_FOUND', 'Voyageur de réservation introuvable.'),
  bookingNotEligible: () =>
    new PublicApiError(
      409,
      'BAGGAGE_BOOKING_NOT_ELIGIBLE',
      'Le bagage exige une réservation confirmée et un voyage actif.',
    ),
  invalidTransition: () =>
    new PublicApiError(
      409,
      'BAGGAGE_INVALID_TRANSITION',
      'Cette transition de bagage n’est pas autorisée.',
    ),
  invalidWeight: () =>
    new PublicApiError(
      422,
      'BAGGAGE_WEIGHT_INVALID',
      'Le poids doit être compris entre 0,001 et 999,999 kg, avec trois décimales maximum.',
    ),
  invalidTimestamp: () =>
    new PublicApiError(
      422,
      'BAGGAGE_EVENT_TIME_INVALID',
      'La date de l’événement est hors de la fenêtre autorisée.',
    ),
  invalidLocation: () =>
    new PublicApiError(
      422,
      'BAGGAGE_EVENT_LOCATION_INVALID',
      'Le point opérationnel ne fait pas partie du trajet de ce bagage.',
    ),
  idempotencyConflict: () =>
    new PublicApiError(
      409,
      'BAGGAGE_CLIENT_EVENT_ID_REUSED',
      'Cet identifiant d’événement a déjà été utilisé avec un autre contenu.',
    ),
  qrInvalid: () =>
    new PublicApiError(
      422,
      'BAGGAGE_QR_INVALID',
      'Code bagage invalide ou version non prise en charge.',
    ),
};
