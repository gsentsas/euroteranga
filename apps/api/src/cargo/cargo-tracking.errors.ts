import { PublicApiError } from '../auth/http/public-api-error.js';

export const CargoTrackingErrors = {
  notFound: () =>
    new PublicApiError(404, 'CARGO_TRACKING_NOT_FOUND', 'Suivi indisponible ou lien invalide.'),
  expiryInvalid: () =>
    new PublicApiError(
      422,
      'CARGO_TRACKING_TOKEN_EXPIRY_INVALID',
      'La date d’expiration doit être future.',
    ),
};
