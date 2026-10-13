import type { BookingSearchStop, SeatMapCellKind } from '@euroteranga/auth-client';

/** A time in the stop's own timezone (travellers read local times). */
export function formatAt(value: string | null, stop: BookingSearchStop | null): string {
  if (!value) return '—';
  const timeZone = stop?.timezone ?? 'UTC';
  try {
    return `${new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(value))} (${timeZone})`;
  } catch {
    return `${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} (UTC)`;
  }
}

export const stopLabel = (stop: BookingSearchStop | null) =>
  stop ? `${stop.name} (${stop.locality}, ${stop.country.name})` : 'Arrêt inconnu';

export const KIND_LABELS: Record<SeatMapCellKind, string> = {
  SEAT: 'Siège',
  AISLE: 'Allée',
  DRIVER: 'Conducteur',
  DOOR: 'Porte',
  TOILET: 'Toilettes',
  STAIRS: 'Escalier',
  OTHER: 'Autre',
};

export const seatsLabel = (count: number) => `${count} siège${count > 1 ? 's' : ''}`;
