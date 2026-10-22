import { knownAmenities, vehicleTitle, type SiteAmenity } from './fleet.js';
import { localDate } from './departures.js';

/**
 * UI-PUBLIC-2: the planned itinerary of the next bookable departure of a
 * direction, from the public itinerary of the trip (Trips, Fleet). Times are
 * UTC instants shown in each place's own timezone; nothing is typed in the CMS.
 */

/** The public itinerary of a trip, as the API returns it. */
export interface PublicItinerary {
  tripId: string;
  vehicle: {
    name: string | null;
    manufacturer: string;
    model: string;
    amenities: readonly string[];
  } | null;
  waypoints: ReadonlyArray<{
    routeWaypointId: string;
    kind: 'STOP' | 'CHECKPOINT';
    name: string;
    locality: string;
    timezone: string;
    country: { iso2: string; name: string };
    checkpointType: string | null;
    terangaStopKind: string | null;
    facilities: readonly string[];
    plannedArrivalAt: string | null;
    plannedDepartureAt: string | null;
  }>;
}

export interface SitePlace {
  kind: 'STOP' | 'CHECKPOINT';
  name: string;
  locality: string;
  timezone: string;
  country: { iso2: string; name: string };
  checkpointType: string | null;
  terangaStopKind: string | null;
  facilities: readonly string[];
  arrivalAt: string | null;
  departureAt: string | null;
}

export interface SiteItinerary {
  tripId: string;
  origin: SitePlace;
  destination: SitePlace;
  /** Stops and crossings between the origin and the destination, in order. */
  via: SitePlace[];
  /** Countries of the journey, in order, each once. */
  countries: Array<{ iso2: string; name: string }>;
  /** Vehicle assigned to the departure, while it is active. */
  vehicle: { title: string; amenities: SiteAmenity[] } | null;
}

export type ItineraryResult =
  | { status: 'ok'; itinerary: SiteItinerary }
  /** No bookable departure for this direction right now. */
  | { status: 'none' }
  | { status: 'unavailable' };

export type ItineraryLookup = (fromCode: string, toCode: string) => ItineraryResult;

/** The journey between two waypoints of a trip, or null when they are not in order. */
export function journeyItinerary(
  itinerary: PublicItinerary,
  originWaypointId: string,
  destinationWaypointId: string,
): SiteItinerary | null {
  const places = itinerary.waypoints.map((waypoint): SitePlace & { id: string } => ({
    id: waypoint.routeWaypointId,
    kind: waypoint.kind,
    name: waypoint.name,
    locality: waypoint.locality,
    timezone: waypoint.timezone,
    country: waypoint.country,
    checkpointType: waypoint.checkpointType,
    terangaStopKind: waypoint.terangaStopKind,
    facilities: waypoint.facilities,
    arrivalAt: waypoint.plannedArrivalAt,
    departureAt: waypoint.plannedDepartureAt,
  }));
  const start = places.findIndex((place) => place.id === originWaypointId);
  const end = places.findIndex((place) => place.id === destinationWaypointId);
  if (start < 0 || end <= start) return null;
  const journey = places.slice(start, end + 1).map(({ id: _id, ...place }) => place);
  const countries = new Map<string, { iso2: string; name: string }>();
  for (const place of journey) countries.set(place.country.iso2, place.country);
  return {
    tripId: itinerary.tripId,
    origin: journey[0]!,
    destination: journey.at(-1)!,
    via: journey.slice(1, -1),
    countries: [...countries.values()],
    vehicle: itinerary.vehicle
      ? {
          title: vehicleTitle(itinerary.vehicle),
          amenities: knownAmenities(itinerary.vehicle.amenities),
        }
      : null,
  };
}

/** "40 h", "38 h 30". */
export function durationLabel(fromIso: string, toIso: string): string | null {
  const minutes = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`;
}

/** Calendar days between the local departure date and the local arrival date. */
export function dayOffset(
  departure: { at: string; timeZone: string },
  arrival: { at: string; timeZone: string },
): number {
  const day = (iso: string, timeZone: string) =>
    Date.parse(`${localDate(iso, timeZone)}T00:00:00Z`) / 86_400_000;
  return Math.round(day(arrival.at, arrival.timeZone) - day(departure.at, departure.timeZone));
}

/** How a place of the journey is introduced to travellers. */
export function placeKindLabel(place: SitePlace): string {
  if (place.kind === 'STOP') return 'Arrêt';
  const labels: Record<string, string> = {
    BREAK: 'Pause',
    MEAL: 'Pause repas',
    SHOWER: 'Pause douche',
    REST: 'Repos',
    OVERNIGHT: 'Étape nuit',
    FUEL: 'Ravitaillement',
    BORDER: 'Passage de frontière',
    FERRY: 'Traversée ferry',
    TECHNICAL: 'Étape technique',
  };
  const fallbackKind =
    place.checkpointType === 'BORDER'
      ? 'BORDER'
      : place.checkpointType === 'FERRY_TERMINAL' || place.checkpointType === 'PORT'
        ? 'FERRY'
        : null;
  const kind = place.terangaStopKind ?? fallbackKind;
  return kind ? (labels[kind] ?? 'Étape') : 'Étape';
}

export function terangaFacilityLabels(facilities: readonly string[]): string[] {
  const labels: Record<string, string> = {
    RESTROOM: 'toilettes',
    SHOWER: 'douche',
    FOOD: 'repas',
    SECURE_PARKING: 'parking sécurisé',
    FUEL: 'carburant',
  };
  return facilities.flatMap((facility) => (labels[facility] ? [labels[facility]!] : []));
}
