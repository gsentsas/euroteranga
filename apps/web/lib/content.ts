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
  siteMediaOf,
  type AppLinks,
  type FromPrice,
  type PublicMediaRecord,
  type RouteDirection,
  type SiteContext,
  type SiteMedia,
} from '@euroteranga/site';
import { publicEnv } from './env';

/**
 * Server-side reads of the published content (CMS-1) and of the "from"
 * prices (Pricing, PR-08), through the Core API only. Responses are cached
 * by Next.js for a short time; a publication appears within a minute.
 */
const CONTENT_REVALIDATE_SECONDS = 60;
const PRICE_REVALIDATE_SECONDS = 300;
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
}

interface PublicJourney {
  fare: FromPrice;
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

async function fromPrices(): Promise<SiteContext['fromPrices']> {
  const stops = await read<{ items: PublicStop[] }>(
    '/v1/booking/stops?limit=50',
    PRICE_REVALIDATE_SECONDS,
  );
  if (stops.status !== 'ok') return {};
  const byCode = (code: string) => stops.data.items.find((stop) => stop.code === code);
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

const MEDIA_BATCH = 50;

/**
 * Active images among `ids` (MEDIA-1). Unknown or archived ones are absent,
 * and an unavailable API only leaves the images out: text never waits.
 */
export async function loadMedia(ids: readonly string[]): Promise<Map<string, SiteMedia>> {
  const found = new Map<string, SiteMedia>();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += MEDIA_BATCH) {
    const batch = unique.slice(start, start + MEDIA_BATCH);
    const result = await read<{ items: Array<PublicMediaRecord & { id: string }> }>(
      `/v1/media?ids=${batch.join(',')}`,
      CONTENT_REVALIDATE_SECONDS,
    );
    if (result.status !== 'ok') continue;
    for (const item of result.data.items) found.set(item.id, siteMediaOf(item, publicApiUrl));
  }
  return found;
}

/** Published settings and navigation (defaults until published), links and prices. */
export async function loadSiteContext(options: {
  prices: boolean;
  mediaIds?: readonly string[];
}): Promise<SiteContext> {
  const [site, media] = await Promise.all([
    read<{ settings: unknown; navigation: unknown }>(
      '/v1/content/site',
      CONTENT_REVALIDATE_SECONDS,
    ),
    loadMedia(options.mediaIds ?? []),
  ]);
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
    fromPrices: options.prices ? await fromPrices() : {},
    media: (id) => media.get(id) ?? null,
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
