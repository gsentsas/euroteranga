import type { AdminTripRouteWaypoint, TripStatus } from '@euroteranga/auth-client';

export const TRIP_STATUS_LABELS: Record<TripStatus, string> = {
  DRAFT: 'Brouillon',
  SCHEDULED: 'Planifié',
  CANCELLED: 'Annulé',
};

export const TRIP_ACTION_LABELS: Record<string, string> = {
  TRIP_CREATED: 'Création',
  TRIP_TIMETABLE_REPLACED: 'Horaire enregistré',
  TRIP_SCHEDULED: 'Planification',
  TRIP_CANCELLED: 'Annulation',
  TRIP_VEHICLE_CHANGED: 'Changement de véhicule',
  TRIP_FARE_TABLE_CHANGED: 'Changement de tarification',
};

const utcFormat = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** Times are stored and entered in UTC; this is the canonical display. */
export function formatUtc(value: string | null): string {
  return value ? `${utcFormat.format(new Date(value))} UTC` : '—';
}

/** Presentation in the waypoint's own timezone (falls back silently). */
export function formatLocal(value: string, timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return null;
  }
}

/** `<input type="datetime-local">` value, interpreted as UTC. */
export function toUtcInput(value: string | null): string {
  return value ? value.slice(0, 16) : '';
}

export function fromUtcInput(value: string): string | null {
  return value ? `${value}:00Z` : null;
}

export function placeOf(waypoint: AdminTripRouteWaypoint): {
  kind: string;
  code: string;
  name: string;
  timezone: string;
} {
  const place = waypoint.stop ?? waypoint.checkpoint;
  return {
    kind: waypoint.stop ? 'Arrêt' : 'Checkpoint',
    code: place?.code ?? '?',
    name: place?.name ?? '?',
    timezone: place?.timezone ?? 'UTC',
  };
}
