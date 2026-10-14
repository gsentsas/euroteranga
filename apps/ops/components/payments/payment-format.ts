import type { CustomerBookingStatus, PaymentStatus } from '@euroteranga/auth-client';

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  PENDING: 'En attente',
  SUCCEEDED: 'Réussi',
  FAILED: 'Échoué',
  CANCELLED: 'Annulé',
};

export const BOOKING_STATUS_LABELS: Record<CustomerBookingStatus, string> = {
  HELD: 'Provisoire',
  CONFIRMED: 'Confirmée',
  EXPIRED: 'Expirée',
  CANCELLED: 'Annulée',
};

/** A UTC instant shown in the operator's reference timezone. */
export function formatInstant(value: string | null, timeZone = 'UTC'): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value));
}
