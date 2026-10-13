import { PublicApiError } from '../auth/http/public-api-error.js';

/**
 * Stable public errors of the booking domain. A customer never learns whether
 * a booking of someone else exists: unknown and foreign bookings are both
 * BOOKING_NOT_FOUND.
 */
export const BookingErrors = {
  notFound: () => new PublicApiError(404, 'BOOKING_NOT_FOUND', 'Réservation introuvable.'),
  tripNotBookable: () =>
    new PublicApiError(404, 'BOOKING_TRIP_NOT_BOOKABLE', 'Ce voyage n’est pas réservable.'),
  tripDeparted: () => new PublicApiError(422, 'BOOKING_TRIP_DEPARTED', 'Ce voyage est déjà parti.'),
  pricingNotConfigured: () =>
    new PublicApiError(
      422,
      'BOOKING_PRICING_NOT_CONFIGURED',
      'Les tarifs de ce voyage ne sont pas encore disponibles.',
    ),
  seatMapNotConfigured: () =>
    new PublicApiError(
      422,
      'BOOKING_SEAT_MAP_NOT_CONFIGURED',
      'Le plan de sièges de ce voyage n’est pas encore disponible.',
    ),
  odInvalid: () =>
    new PublicApiError(
      422,
      'BOOKING_OD_INVALID',
      'Trajet invalide : choisissez un arrêt de montée puis un arrêt de descente situé après.',
    ),
  fareNotConfigured: () =>
    new PublicApiError(
      404,
      'BOOKING_FARE_NOT_CONFIGURED',
      'Aucun tarif n’est proposé pour ce trajet.',
    ),
  seatInvalid: () =>
    new PublicApiError(
      422,
      'BOOKING_SEAT_INVALID',
      'Choisissez des sièges distincts du plan de ce voyage.',
    ),
  seatUnavailable: () =>
    new PublicApiError(
      409,
      'BOOKING_SEAT_UNAVAILABLE',
      'Un des sièges choisis n’est plus disponible sur ce trajet. Choisissez-en un autre.',
    ),
  tooManySeats: (max: number) =>
    new PublicApiError(
      422,
      'BOOKING_TOO_MANY_SEATS',
      `Vous pouvez réserver au plus ${max} siège${max > 1 ? 's' : ''} à la fois.`,
    ),
  expired: () =>
    new PublicApiError(409, 'BOOKING_EXPIRED', 'Cette réservation provisoire a expiré.'),
  cancelled: () =>
    new PublicApiError(409, 'BOOKING_CANCELLED', 'Cette réservation est déjà annulée.'),
  confirmed: () =>
    new PublicApiError(
      409,
      'BOOKING_CONFIRMED',
      'Cette réservation est confirmée (payée) : elle ne peut pas être annulée en ligne.',
    ),
  cancelConflict: () =>
    new PublicApiError(
      409,
      'BOOKING_CANCEL_CONFLICT',
      'La réservation a changé entre-temps. Rechargez-la avant de réessayer.',
    ),
};
