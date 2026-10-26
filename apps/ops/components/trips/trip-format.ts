import type { AdminTripRouteWaypoint, TripStatus } from '@euroteranga/auth-client';

export const TRIP_STATUS_LABELS: Record<TripStatus, string> = {
  DRAFT: 'Brouillon',
  SCHEDULED: 'Planifié',
  IN_PROGRESS: 'En cours',
  COMPLETED: 'Terminé',
  CANCELLED: 'Annulé',
};

export const TRIP_ACTION_LABELS: Record<string, string> = {
  TRIP_CREATED: 'Création',
  TRIP_TIMETABLE_REPLACED: 'Horaire enregistré',
  TRIP_SCHEDULED: 'Planification',
  TRIP_CANCELLED: 'Annulation',
  TRIP_VEHICLE_CHANGED: 'Changement de véhicule',
  TRIP_SUPPORT_VEHICLE_CHANGED: "Changement de véhicule d'appoint",
  TRIP_FARE_TABLE_CHANGED: 'Changement de tarification',
  TRIP_SEAT_MAP_CHANGED: 'Changement de plan de sièges',
  TRIP_COST_UPDATED: 'Coûts prévisionnels enregistrés',
  TRIP_DEPARTED: 'Départ réel',
  TRIP_COMPLETED: 'Arrivée / clôture',
  // Audited reads the API files against the trip (shown on request only).
  FINANCE_TRIP_ACCESSED: 'Consultation Finance du voyage',
  OPS_PROFIT_TRIP_ACCESSED: 'Consultation de la rentabilité',
  DEPARTURE_READINESS_ACCESSED: 'Évaluation de la préparation au départ',
};

/** An audited consultation, not a change of the trip. */
export function isAccessEvent(action: string): boolean {
  return action.endsWith('_ACCESSED');
}

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

/** "ET-COACH-001 « Teranga 01 »": the code, then the operational name when set. */
export function vehicleIdentity(vehicle: { code: string; name: string | null }): string {
  return vehicle.name ? `${vehicle.code} « ${vehicle.name} »` : vehicle.code;
}

export function formatCargoVolume(liters: number | null): string {
  if (liters === null) return '—';
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(liters / 1000)} m³`;
}

export type TripTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export function tripStatusTone(status: TripStatus): TripTone {
  switch (status) {
    case 'DRAFT':
      return 'neutral';
    case 'SCHEDULED':
      return 'info';
    case 'IN_PROGRESS':
      return 'warning';
    case 'COMPLETED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
  }
}

const dayFormat = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const timeFormat = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short', timeZone: 'UTC' });

/** "lun. 11 janv. 2027" (UTC day, like every stored time). */
export function formatUtcDay(value: string): string {
  return dayFormat.format(new Date(value));
}

/** "08:00 UTC". */
export function formatUtcTime(value: string): string {
  return `${timeFormat.format(new Date(value))} UTC`;
}

/** Planned duration between two instants: "3 j 11 h", "11 h 30 min". */
export function formatDuration(from: string, to: string): string | null {
  const minutes = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} j ${hours} h` : `${days} j`;
  if (hours > 0) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  return `${rest} min`;
}

/** Exact minor units (string or integer) with French grouping, never through floats. */
export function formatMinor(
  amountMinor: string | number,
  currencyCode: string,
  minorUnit: number,
): string {
  const raw = String(amountMinor);
  const negative = raw.startsWith('-');
  const absolute = BigInt(negative ? raw.slice(1) : raw);
  const factor = 10n ** BigInt(minorUnit);
  const whole = (absolute / factor).toString();
  const groups: string[] = [];
  for (let end = whole.length; end > 0; end -= 3) {
    groups.unshift(whole.slice(Math.max(0, end - 3), end));
  }
  const fraction =
    minorUnit > 0 ? `,${(absolute % factor).toString().padStart(minorUnit, '0')}` : '';
  return `${negative ? '−' : ''}${groups.join(' ')}${fraction} ${currencyCode}`;
}

const kgFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

/** "1 234,5 kg" from an exact decimal string or a number. */
export function formatKg(value: string | number): string {
  return `${kgFormat.format(Number(value))} kg`;
}

/** First and last waypoint: what the trip goes from and to. */
export function tripEnds(waypoints: readonly AdminTripRouteWaypoint[]) {
  const first = waypoints[0];
  const last = waypoints.at(-1);
  return {
    origin: first ? placeOf(first) : null,
    destination: last && last !== first ? placeOf(last) : null,
  };
}

/** "09:00" in the place's own time zone, or null when it is UTC or unknown. */
export function formatLocalTime(value: string, timezone: string): string | null {
  if (timezone === 'UTC' || timezone === 'Etc/UTC') return null;
  try {
    return new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short', timeZone: timezone }).format(
      new Date(value),
    );
  } catch {
    return null;
  }
}
