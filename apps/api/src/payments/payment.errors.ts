import { PublicApiError } from '../auth/http/public-api-error.js';

/**
 * Stable public errors of the payment domain. A customer never learns whether
 * a payment of someone else exists: unknown and foreign payments are both
 * PAYMENT_NOT_FOUND. Provider events get one generic refusal
 * (PAYMENT_WEBHOOK_INVALID) whatever the failed check.
 */
export const PaymentErrors = {
  notFound: () => new PublicApiError(404, 'PAYMENT_NOT_FOUND', 'Paiement introuvable.'),
  providerUnavailable: () =>
    new PublicApiError(
      503,
      'PAYMENT_PROVIDER_UNAVAILABLE',
      'Le paiement en ligne n’est pas disponible pour le moment.',
    ),
  methodUnavailable: () =>
    new PublicApiError(
      409,
      'PAYMENT_METHOD_UNAVAILABLE',
      'Ce moyen de paiement n’est pas disponible pour ce pays et cette devise.',
    ),
  countryUnsupported: () =>
    new PublicApiError(
      422,
      'PAYMENT_COUNTRY_UNSUPPORTED',
      'Le paiement n’est pas proposé pour ce pays.',
    ),
  currencyUnsupported: () =>
    new PublicApiError(
      422,
      'PAYMENT_CURRENCY_UNSUPPORTED',
      'Cette devise n’est pas acceptée pour le paiement.',
    ),
  fxUnavailable: () =>
    new PublicApiError(
      503,
      'PAYMENT_FX_UNAVAILABLE',
      'Le montant dans cette devise ne peut pas être calculé pour le moment.',
    ),
  quoteNotFound: () =>
    new PublicApiError(404, 'PAYMENT_QUOTE_NOT_FOUND', 'Proposition de paiement introuvable.'),
  quoteAlreadyUsed: () =>
    new PublicApiError(
      409,
      'PAYMENT_QUOTE_ALREADY_USED',
      'Cette proposition de paiement a déjà servi. Demandez un nouveau montant.',
    ),
  quoteLimitReached: () =>
    new PublicApiError(
      429,
      'PAYMENT_QUOTE_LIMIT_REACHED',
      'Trop de propositions de paiement pour cette réservation.',
    ),
  quoteExpired: () =>
    new PublicApiError(
      409,
      'PAYMENT_QUOTE_EXPIRED',
      'Cette proposition de paiement a expiré. Demandez un nouveau montant.',
    ),
  quoteMismatch: () =>
    new PublicApiError(
      422,
      'PAYMENT_QUOTE_MISMATCH',
      'La proposition de paiement ne correspond pas à ce paiement.',
    ),
  bookingNotPayable: () =>
    new PublicApiError(
      409,
      'PAYMENT_BOOKING_NOT_PAYABLE',
      'Cette réservation ne peut pas être payée.',
    ),
  bookingExpired: () =>
    new PublicApiError(
      409,
      'PAYMENT_BOOKING_EXPIRED',
      'La réservation provisoire a expiré : elle ne peut plus être payée.',
    ),
  bookingConfirmed: () =>
    new PublicApiError(409, 'PAYMENT_BOOKING_CONFIRMED', 'Cette réservation est déjà confirmée.'),
  alreadyPending: () =>
    new PublicApiError(
      409,
      'PAYMENT_ALREADY_PENDING',
      'Un paiement est déjà en cours pour cette réservation.',
    ),
  alreadySucceeded: () =>
    new PublicApiError(409, 'PAYMENT_ALREADY_SUCCEEDED', 'Ce paiement a déjà réussi.'),
  invalidTransition: () =>
    new PublicApiError(409, 'PAYMENT_INVALID_TRANSITION', 'Ce paiement est déjà terminé.'),
  idempotencyKeyInvalid: () =>
    new PublicApiError(
      400,
      'PAYMENT_IDEMPOTENCY_KEY_INVALID',
      'L’en-tête Idempotency-Key doit contenir de 16 à 64 caractères (lettres, chiffres, - ou _).',
    ),
  idempotencyKeyReused: () =>
    new PublicApiError(
      422,
      'PAYMENT_IDEMPOTENCY_KEY_REUSED',
      'Cette clé d’idempotence a déjà servi pour une autre réservation.',
    ),
  webhookInvalid: (status: 400 | 401 | 413 | 415 | 422 = 400) =>
    new PublicApiError(status, 'PAYMENT_WEBHOOK_INVALID', 'Événement de paiement refusé.'),
  webhookReplay: () =>
    new PublicApiError(409, 'PAYMENT_WEBHOOK_REPLAY', 'Événement de paiement déjà reçu.'),
};
