import {
  DEFAULT_HOME_PAGE,
  DEFAULT_NAVIGATION,
  DEFAULT_SITE_SETTINGS,
  navigationSchema,
  pageDocumentSchema,
  siteSettingsSchema,
  type PageDocument,
} from '@euroteranga/content';
import {
  directionKey,
  journeyItinerary,
  knownAmenities,
  localDate,
  resolveMedia,
  siteMediaOf,
  type AppLinks,
  type FromPrice,
  type ItineraryResult,
  type PublicMediaRecord,
  type PublicItinerary,
  type RouteDirection,
  type SiteContext,
  type SiteDeparture,
  type SiteMedia,
  type SiteStop,
  type SiteVehicle,
} from '@euroteranga/site';
import { publicEnv } from './env';

/**
 * Server-side reads of the published content (CMS-1) and of the "from"
 * prices (Pricing, PR-08), through the Core API only. Responses are cached
 * by Next.js for a short time; a publication appears within a minute.
 */
const CONTENT_REVALIDATE_SECONDS = 60;
const PRICE_REVALIDATE_SECONDS = 300;
/** Remaining seats change with every booking: departures are refreshed every minute. */
const DEPARTURES_REVALIDATE_SECONDS = 60;
const FLEET_REVALIDATE_SECONDS = 300;
/** Departures read per direction (the block shows at most 6 in total). */
const DEPARTURES_PER_DIRECTION = 12;
const TIMEOUT_MS = 3000;

/** Loopback API base for server-side reads when set (avoids the public round trip). */
function apiBase(): string {
  return (process.env.CORE_API_INTERNAL_URL ?? publicEnv.NEXT_PUBLIC_API_BASE_URL).replace(
    /\/+$/,
    '',
  );
}

type Read<T> = { status: 'ok'; data: T } | { status: 'missing' } | { status: 'unavailable' };

async function read<T>(path: string, revalidate: number): Promise<Read<T>> {
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      next: { revalidate },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) return { status: 'missing' };
    if (!response.ok) return { status: 'unavailable' };
    return { status: 'ok', data: (await response.json()) as T };
  } catch {
    return { status: 'unavailable' };
  }
}

export type PageResult =
  | { status: 'ok'; document: PageDocument; fallback: boolean }
  | { status: 'missing' }
  | { status: 'unavailable' };

/**
 * The published page at `path`. The home page falls back to the default
 * content when nothing is published yet or the API cannot be reached, so the
 * public site never goes blank.
 */
export async function loadPage(path: string): Promise<PageResult> {
  const result = await read<{ document: unknown }>(
    `/v1/content/pages?path=${encodeURIComponent(path)}`,
    CONTENT_REVALIDATE_SECONDS,
  );
  if (result.status === 'ok') {
    const parsed = pageDocumentSchema.safeParse(result.data.document);
    if (parsed.success) return { status: 'ok', document: parsed.data, fallback: false };
  }
  if (path === '/' && result.status !== 'ok') {
    return { status: 'ok', document: pageDocumentSchema.parse(DEFAULT_HOME_PAGE), fallback: true };
  }
  if (result.status === 'missing') return { status: 'missing' };
  return { status: 'unavailable' };
}

/** Runtime overrides of the application links (local development, CI, staging). */
function appLinks(settingsApps: {
  bookingUrl: string;
  clientUrl: string;
  trackingUrl: string;
}): AppLinks {
  return {
    booking: process.env.PUBLIC_BOOKING_URL ?? settingsApps.bookingUrl,
    client: process.env.PUBLIC_CLIENT_URL ?? settingsApps.clientUrl,
    tracking: process.env.PUBLIC_TRACKING_URL ?? settingsApps.trackingUrl,
  };
}

interface PublicStop {
  id: string;
  code: string;
  name: string;
  locality: string;
  timezone: string;
  country: { iso2: string; name: string };
}

interface PublicJourney {
  tripId: string;
  origin: {
    routeWaypointId: string;
    stop: PublicStop | null;
    plannedDepartureAt: string | null;
  };
  destination: {
    routeWaypointId: string;
    stop: PublicStop | null;
    plannedArrivalAt: string | null;
  };
  availableSeatCount: number;
  fare: FromPrice;
}

const siteStopOf = (stop: PublicStop): SiteStop => ({
  code: stop.code,
  name: stop.name,
  locality: stop.locality,
  countryName: stop.country.name,
  timezone: stop.timezone,
});

/**
 * Active stops of the network (public stops API), or null when it cannot
 * answer. The stops a page names by code are always resolved exactly (a
 * search by code), even beyond the first page of the list.
 */
async function loadStops(codes: readonly string[]): Promise<PublicStop[] | null> {
  const [listed, ...named] = await Promise.all([
    read<{ items: PublicStop[] }>('/v1/booking/stops?limit=50', PRICE_REVALIDATE_SECONDS),
    ...[...new Set(codes)].map((code) =>
      read<{ items: PublicStop[] }>(
        `/v1/booking/stops?query=${encodeURIComponent(code)}&limit=50`,
        PRICE_REVALIDATE_SECONDS,
      ),
    ),
  ]);
  if (listed?.status !== 'ok') return null;
  const stops = new Map(listed.data.items.map((stop) => [stop.code, stop]));
  [...new Set(codes)].forEach((code, index) => {
    const result = named[index];
    const exact =
      result?.status === 'ok' ? result.data.items.find((stop) => stop.code === code) : undefined;
    if (exact) stops.set(exact.code, exact);
  });
  return [...stops.values()];
}

/**
 * UI-PUBLIC-1: bookable departures of each direction, from the public trip
 * search (Trips, Booking, Pricing). A direction whose search fails is null:
 * the page says so instead of inventing dates.
 */
async function loadJourneys(
  routes: ReadonlyArray<{ fromCode: string; toCode: string }>,
  stops: PublicStop[] | null,
): Promise<Map<string, PublicJourney[] | null>> {
  const found = new Map<string, PublicJourney[] | null>();
  await Promise.all(
    routes.map(async ({ fromCode, toCode }) => {
      const key = directionKey(fromCode, toCode);
      const origin = stops?.find((stop) => stop.code === fromCode);
      const destination = stops?.find((stop) => stop.code === toCode);
      if (!origin || !destination) {
        // Unknown stops are not an outage: the direction simply has no journey.
        found.set(key, stops ? [] : null);
        return;
      }
      const result = await read<{ items: PublicJourney[] }>(
        // Full trips are filtered before the limit: they never hide bookable ones.
        `/v1/booking/trips?originStopId=${origin.id}&destinationStopId=${destination.id}&minAvailableSeats=1&limit=${DEPARTURES_PER_DIRECTION}`,
        DEPARTURES_REVALIDATE_SECONDS,
      );
      if (result.status !== 'ok') {
        found.set(key, null);
        return;
      }
      found.set(key, result.data.items);
    }),
  );
  return found;
}

/** Departures are a presentation of the shared public journey searches. */
function departuresOf(
  routes: ReadonlyArray<{ fromCode: string; toCode: string }>,
  journeys: Map<string, PublicJourney[] | null>,
  stops: PublicStop[] | null,
): Map<string, SiteDeparture[] | null> {
  const found = new Map<string, SiteDeparture[] | null>();
  for (const { fromCode, toCode } of routes) {
    const key = directionKey(fromCode, toCode);
    const items = journeys.get(key) ?? null;
    const origin = stops?.find((stop) => stop.code === fromCode);
    const destination = stops?.find((stop) => stop.code === toCode);
    found.set(
      key,
      items?.flatMap((item) =>
        item.origin.plannedDepartureAt && origin && destination
          ? [
              {
                tripId: item.tripId,
                from: siteStopOf(item.origin.stop ?? origin),
                to: siteStopOf(item.destination.stop ?? destination),
                departureAt: item.origin.plannedDepartureAt,
                availableSeats: item.availableSeatCount,
                fare: item.fare,
              },
            ]
          : [],
      ) ?? null,
    );
  }
  return found;
}

/** Planned itinerary of the first bookable departure of every requested direction. */
async function loadItineraries(
  routes: ReadonlyArray<{ fromCode: string; toCode: string }>,
  journeys: Map<string, PublicJourney[] | null>,
): Promise<Map<string, ItineraryResult>> {
  const found = new Map<string, ItineraryResult>();
  await Promise.all(
    routes.map(async ({ fromCode, toCode }) => {
      const key = directionKey(fromCode, toCode);
      const searched = journeys.get(key) ?? null;
      if (searched === null) {
        found.set(key, { status: 'unavailable' });
        return;
      }
      const journey = searched.find((item) => item.origin.plannedDepartureAt !== null);
      if (!journey) {
        found.set(key, { status: 'none' });
        return;
      }
      const result = await read<PublicItinerary>(
        `/v1/booking/trips/${encodeURIComponent(journey.tripId)}/itinerary`,
        DEPARTURES_REVALIDATE_SECONDS,
      );
      if (result.status !== 'ok') {
        found.set(key, { status: 'unavailable' });
        return;
      }
      const itinerary = journeyItinerary(
        result.data,
        journey.origin.routeWaypointId,
        journey.destination.routeWaypointId,
      );
      found.set(key, itinerary ? { status: 'ok', itinerary } : { status: 'unavailable' });
    }),
  );
  return found;
}

/** Active public fleet facts; operational identifiers never leave the API. */
async function loadFleet(): Promise<SiteVehicle[] | null> {
  const result = await read<{ items: SiteVehicle[] }>(
    '/v1/booking/fleet',
    FLEET_REVALIDATE_SECONDS,
  );
  if (result.status !== 'ok') return null;
  return result.data.items.map((vehicle) => ({
    ...vehicle,
    amenities: knownAmenities(vehicle.amenities),
  }));
}

/** Lowest current fare of one direction, or null (no bookable trip, mixed currencies). */
async function fromPrice(origin: PublicStop | undefined, destination: PublicStop | undefined) {
  if (!origin || !destination) return null;
  const result = await read<{ items: PublicJourney[] }>(
    `/v1/booking/trips?originStopId=${origin.id}&destinationStopId=${destination.id}&limit=50`,
    PRICE_REVALIDATE_SECONDS,
  );
  if (result.status !== 'ok' || result.data.items.length === 0) return null;
  const fares = result.data.items.map((item) => item.fare);
  const currency = fares[0]!.currencyCode;
  if (fares.some((fare) => fare.currencyCode !== currency)) return null;
  return fares.reduce((lowest, fare) => (fare.amountMinor < lowest.amountMinor ? fare : lowest));
}

async function fromPrices(stops: PublicStop[] | null): Promise<SiteContext['fromPrices']> {
  if (!stops) return {};
  const byCode = (code: string) => stops.find((stop) => stop.code === code);
  const [paris, dakar] = [byCode('PAR'), byCode('DKR')];
  const entries: Array<[RouteDirection, FromPrice | null]> = [
    ['PAR-DKR', await fromPrice(paris, dakar)],
    ['DKR-PAR', await fromPrice(dakar, paris)],
  ];
  return Object.fromEntries(entries);
}

/** Image URLs are public: the browser loads them from the API origin (CSP img-src). */
function publicApiUrl(path: string): string {
  return `${publicEnv.NEXT_PUBLIC_API_BASE_URL.replace(/\/+$/, '')}${path}`;
}

/**
 * Active images among `ids` (MEDIA-1), in batches of 50 resolved in
 * parallel (bounded). Unknown or archived ones are absent, and a failed or
 * slow batch only leaves its own images out: text never waits on images.
 */
export async function loadMedia(ids: readonly string[]): Promise<Map<string, SiteMedia>> {
  return resolveMedia(ids, async (batch) => {
    const result = await read<{ items: Array<PublicMediaRecord & { id: string }> }>(
      `/v1/media?ids=${batch.join(',')}`,
      CONTENT_REVALIDATE_SECONDS,
    );
    if (result.status !== 'ok') return null;
    return new Map(result.data.items.map((item) => [item.id, siteMediaOf(item, publicApiUrl)]));
  });
}

/** Published settings and navigation (defaults until published), links and prices. */
export async function loadSiteContext(options: {
  prices: boolean;
  mediaIds?: readonly string[];
  /** The page has a trip search: list the active stops (and its own two). */
  search?: { fromCode: string; toCode: string };
  /** Directions of the page's departures blocks. */
  departureRoutes?: ReadonlyArray<{ fromCode: string; toCode: string }>;
  /** Directions of the page's itinerary blocks. */
  itineraryRoutes?: ReadonlyArray<{ fromCode: string; toCode: string }>;
  /** Whether the page contains a public fleet block. */
  fleet?: boolean;
}): Promise<SiteContext> {
  const departureRoutes = options.departureRoutes ?? [];
  const itineraryRoutes = options.itineraryRoutes ?? [];
  const routes = [
    ...new Map(
      [...departureRoutes, ...itineraryRoutes].map((route) => [
        directionKey(route.fromCode, route.toCode),
        route,
      ]),
    ).values(),
  ];
  const needsStops = options.prices || options.search !== undefined || routes.length > 0;
  const named = [
    ...(options.prices ? ['PAR', 'DKR'] : []),
    ...(options.search ? [options.search.fromCode, options.search.toCode] : []),
    ...routes.flatMap((route) => [route.fromCode, route.toCode]),
  ];
  const [site, media, stops, fleet] = await Promise.all([
    read<{ settings: unknown; navigation: unknown }>(
      '/v1/content/site',
      CONTENT_REVALIDATE_SECONDS,
    ),
    loadMedia(options.mediaIds ?? []),
    needsStops ? loadStops(named) : Promise.resolve(null),
    options.fleet ? loadFleet() : Promise.resolve(undefined),
  ]);
  const [prices, journeys] = await Promise.all([
    options.prices ? fromPrices(stops) : Promise.resolve({}),
    routes.length > 0 ? loadJourneys(routes, stops) : Promise.resolve(null),
  ]);
  const departures = journeys ? departuresOf(departureRoutes, journeys, stops) : null;
  const itineraries =
    journeys && itineraryRoutes.length > 0
      ? await loadItineraries(itineraryRoutes, journeys)
      : null;
  const settings =
    (site.status === 'ok' && siteSettingsSchema.safeParse(site.data.settings).data) ||
    DEFAULT_SITE_SETTINGS;
  const navigation =
    (site.status === 'ok' && navigationSchema.safeParse(site.data.navigation).data) ||
    DEFAULT_NAVIGATION;
  return {
    settings,
    navigation,
    apps: appLinks(settings.apps),
    fromPrices: prices,
    media: (id) => media.get(id.toLowerCase()) ?? null,
    ...(options.search && stops ? { stops: stops.map(siteStopOf) } : {}),
    ...(departures
      ? {
          departures: (fromCode: string, toCode: string) =>
            departures.get(directionKey(fromCode, toCode)) ?? null,
        }
      : {}),
    ...(itineraries
      ? {
          itineraries: (fromCode: string, toCode: string) =>
            itineraries.get(directionKey(fromCode, toCode)) ?? { status: 'unavailable' },
        }
      : {}),
    ...(options.fleet ? { fleet: fleet ?? null } : {}),
    today: localDate(
      new Date().toISOString(),
      options.search
        ? (stops?.find((stop) => stop.code === options.search?.fromCode)?.timezone ??
            'Europe/Paris')
        : 'Europe/Paris',
    ),
    year: new Date().getUTCFullYear(),
  };
}

/** Paths of the served, indexable pages; the home page when the API cannot answer. */
export async function loadSitemapPaths(): Promise<
  Array<{ path: string; updatedAt: string | null }>
> {
  const result = await read<{ items: Array<{ path: string; updatedAt: string }> }>(
    '/v1/content/sitemap',
    CONTENT_REVALIDATE_SECONDS,
  );
  if (result.status !== 'ok') return [{ path: '/', updatedAt: null }];
  const items = result.data.items.map((item) => ({ path: item.path, updatedAt: item.updatedAt }));
  return items.some((item) => item.path === '/')
    ? items
    : [{ path: '/', updatedAt: null }, ...items];
}
