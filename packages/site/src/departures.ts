import type { FromPrice } from './money.js';

/**
 * UI-PUBLIC-1: next departures and the booking deep link. Everything here
 * comes from the public trip search (Trips, Booking, Pricing): dates,
 * remaining seats and fares are never written in the CMS.
 */

/** An active stop of the network, as the public stops API describes it. */
export interface SiteStop {
  code: string;
  name: string;
  locality: string;
  countryName: string;
  timezone: string;
}

/** One bookable journey of the public trip search. */
export interface SiteDeparture {
  tripId: string;
  from: SiteStop;
  to: SiteStop;
  /** Planned departure from the origin (ISO 8601, UTC). */
  departureAt: string;
  availableSeats: number;
  /** Exact fare of this journey (Pricing). */
  fare: FromPrice;
}

/** Departures of one direction; null when the trip search could not answer. */
export type DepartureLookup = (fromCode: string, toCode: string) => readonly SiteDeparture[] | null;

export const directionKey = (fromCode: string, toCode: string) => `${fromCode}>${toCode}`;

/** Passengers offered by the search form (the booking application decides). */
export const MAX_SEARCH_PASSENGERS = 8;

/** The soonest departures of every direction together, and whether one could not be read. */
export function nextDepartures(
  routes: ReadonlyArray<{ fromCode: string; toCode: string }>,
  lookup: DepartureLookup | undefined,
  limit: number,
): { items: SiteDeparture[]; unavailable: boolean } {
  let unavailable = !lookup;
  const all: SiteDeparture[] = [];
  for (const route of routes) {
    const found = lookup?.(route.fromCode, route.toCode) ?? null;
    if (found === null) unavailable = true;
    else all.push(...found);
  }
  const items = all
    .filter((departure) => departure.availableSeats > 0)
    .sort((a, b) => a.departureAt.localeCompare(b.departureAt))
    .slice(0, limit);
  return { items, unavailable };
}

function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** The calendar day of an instant in a timezone, as YYYY-MM-DD. */
export function localDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** "jeu. 12 nov. 2026" and "08:00", in the origin's own timezone (travellers read local times). */
export function departureLabel(iso: string, timeZone: string): { day: string; time: string } {
  const zone = safeTimeZone(timeZone);
  const date = new Date(iso);
  return {
    day: new Intl.DateTimeFormat('fr-FR', {
      timeZone: zone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date),
    time: new Intl.DateTimeFormat('fr-FR', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(date),
  };
}

/** "3 places disponibles", "Dernière place disponible". */
export function seatsLabel(count: number): string {
  if (count === 1) return 'Dernière place disponible';
  return count <= 5 ? `Plus que ${count} places` : `${count} places disponibles`;
}

/**
 * The booking application, pre-filled: ?from=PAR&to=DKR&date=YYYY-MM-DD
 * (and passengers). The base keeps its own path and query.
 */
export function bookingSearchHref(
  base: string,
  search: { from: string; to: string; date?: string; passengers?: number },
): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return base;
  }
  url.searchParams.set('from', search.from);
  url.searchParams.set('to', search.to);
  if (search.date) url.searchParams.set('date', search.date);
  if (search.passengers) url.searchParams.set('passengers', String(search.passengers));
  return url.toString();
}

/** Label of a stop in a list: "Dakar · Gare routière des Baux maraîchers". */
export function stopOptionLabel(stop: SiteStop): string {
  return stop.name === stop.locality ? stop.name : `${stop.locality} · ${stop.name}`;
}
