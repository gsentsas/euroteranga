import { PublicApiError } from '../auth/http/public-api-error.js';

export const PassengerDocumentErrors = {
  passengerNotFound: () => new PublicApiError(404, 'PASSENGER_NOT_FOUND', 'Voyageur introuvable.'),
  documentNotFound: () =>
    new PublicApiError(404, 'PASSENGER_DOCUMENT_NOT_FOUND', 'Document introuvable.'),
  bookingNotFound: () => new PublicApiError(404, 'BOOKING_NOT_FOUND', 'Réservation introuvable.'),
  bookingNotEligible: () =>
    new PublicApiError(
      409,
      'PASSENGER_BOOKING_NOT_CONFIRMED',
      'Les voyageurs peuvent être ajoutés uniquement à une réservation confirmée.',
    ),
  capacityReached: () =>
    new PublicApiError(
      409,
      'PASSENGER_BOOKING_CAPACITY_REACHED',
      'Tous les sièges de cette réservation ont déjà un voyageur.',
    ),
  nationalityNotFound: () =>
    new PublicApiError(422, 'PASSENGER_NATIONALITY_UNKNOWN', 'Nationalité inconnue.'),
  malformedUpload: () =>
    new PublicApiError(422, 'PASSENGER_DOCUMENT_UPLOAD_INVALID', 'Fichier invalide.'),
  emptyUpload: () => new PublicApiError(422, 'PASSENGER_DOCUMENT_EMPTY', 'Le fichier est vide.'),
  tooLarge: (maxBytes: number) =>
    new PublicApiError(
      413,
      'PASSENGER_DOCUMENT_TOO_LARGE',
      `Le fichier dépasse la limite de ${maxBytes} octets.`,
    ),
  unsupportedMedia: () =>
    new PublicApiError(
      415,
      'PASSENGER_DOCUMENT_MEDIA_UNSUPPORTED',
      'Formats autorisés : PDF, JPEG et PNG.',
    ),
  filenameUnsafe: () =>
    new PublicApiError(
      422,
      'PASSENGER_DOCUMENT_FILENAME_UNSAFE',
      'Le nom du fichier n’est pas accepté.',
    ),
  featureUnavailable: () =>
    new PublicApiError(
      503,
      'PASSENGER_DOCUMENT_FEATURE_UNAVAILABLE',
      'Le service de documents est indisponible.',
    ),
  scannerUnavailable: () =>
    new PublicApiError(
      503,
      'PASSENGER_DOCUMENT_SCAN_UNAVAILABLE',
      'L’analyse de sécurité a échoué. Le fichier n’a pas été accepté.',
    ),
  malwareRejected: () =>
    new PublicApiError(
      422,
      'PASSENGER_DOCUMENT_MALWARE_REJECTED',
      'Le fichier a été refusé par l’analyse de sécurité.',
    ),
};
