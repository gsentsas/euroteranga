'use client';

import {
  DEFAULT_HOME_PAGE,
  DEFAULT_NAVIGATION,
  DEFAULT_SITE_SETTINGS,
  mediaIdsOf,
  navigationSchema,
  pageDocumentSchema,
  siteSettingsSchema,
  type ContentKind,
  type Navigation,
  type PageDocument,
  type SiteSettings,
} from '@euroteranga/content';
import type { BookingSearchResult, BookingSearchStop } from '@euroteranga/auth-client';
import {
  createMediaCache,
  directionKey,
  journeyItinerary,
  knownAmenities,
  localDate,
  SitePage,
  siteMediaOf,
  type ItineraryResult,
  type SiteContext,
  type SiteDeparture,
  type SiteMedia,
  type SiteStop,
  type SiteVehicle,
} from '@euroteranga/site';
import { useEffect, useRef, useState } from 'react';
import { auth } from '../../lib/auth';

const VIEWPORTS = [
  { key: 'mobile', label: 'Mobile', width: 390 },
  { key: 'tablet', label: 'Tablette', width: 768 },
  { key: 'desktop', label: 'Bureau', width: 1280 },
] as const;

type ViewportKey = (typeof VIEWPORTS)[number]['key'];

export interface PreviewSite {
  settings: unknown;
  navigation: unknown;
  /** The page shown when the edited entry is the settings or the navigation. */
  home: unknown;
}

function parsed<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown,
  fallback: T,
): T {
  const result = schema.safeParse(value);
  return result.success ? (result.data as T) : fallback;
}

/** What the website would render for the edited document, or null while it is invalid. */
function previewModel(
  kind: ContentKind,
  document: unknown,
  site: PreviewSite,
): { page: PageDocument; ctx: SiteContext } | null {
  let settings = parsed<SiteSettings>(siteSettingsSchema, site.settings, DEFAULT_SITE_SETTINGS);
  let navigation = parsed<Navigation>(navigationSchema, site.navigation, DEFAULT_NAVIGATION);
  let page = parsed<PageDocument>(
    pageDocumentSchema,
    site.home,
    pageDocumentSchema.parse(DEFAULT_HOME_PAGE),
  );
  if (kind === 'PAGE') {
    const result = pageDocumentSchema.safeParse(document);
    if (!result.success) return null;
    page = result.data;
  } else if (kind === 'SITE_SETTINGS') {
    const result = siteSettingsSchema.safeParse(document);
    if (!result.success) return null;
    settings = result.data;
  } else {
    const result = navigationSchema.safeParse(document);
    if (!result.success) return null;
    navigation = result.data;
  }
  return {
    page,
    ctx: {
      settings,
      navigation,
      apps: {
        booking: settings.apps.bookingUrl,
        client: settings.apps.clientUrl,
        tracking: settings.apps.trackingUrl,
      },
      // Prices are read from Pricing by the website; the preview never shows one.
      fromPrices: {},
      year: new Date().getFullYear(),
    },
  };
}

/**
 * Images of the previewed page, read once from the public media endpoint:
 * like the website, the preview shows active images only (null = absent).
 */
function useMediaCache() {
  const [version, setVersion] = useState(0);
  // One cache per editor: a batch of 50 at a time, each answered batch
  // re-renders the preview, which then requests the next missing ids.
  const [cache] = useState(() =>
    createMediaCache<SiteMedia>(
      async (batch) => {
        const result = await auth.media.many(batch);
        if (!result.ok) return null;
        return new Map(
          result.data.items.map((item) => [item.id, siteMediaOf(item, auth.media.url)]),
        );
      },
      () => setVersion((value) => value + 1),
    ),
  );
  return { cache, version };
}

const siteStopOf = (stop: BookingSearchStop): SiteStop => ({
  code: stop.code,
  name: stop.name,
  locality: stop.locality,
  countryName: stop.country.name,
  timezone: stop.timezone,
});

/** The public reads a page needs, as a stable key (one request set per change). */
function previewNeeds(page: PageDocument | null) {
  const blocks = page?.blocks ?? [];
  const hero = blocks.find((block) => block.type === 'hero');
  const keys = (routes: ReadonlyArray<{ fromCode: string; toCode: string }>) => [
    ...new Set(routes.map((route) => directionKey(route.fromCode, route.toCode))),
  ];
  return {
    search: hero?.search ? [hero.search.fromCode, hero.search.toCode] : null,
    departures: keys(blocks.flatMap((block) => (block.type === 'departures' ? block.routes : []))),
    itineraries: keys(
      blocks.flatMap((block) =>
        block.type === 'itinerary' ? [{ fromCode: block.fromCode, toCode: block.toCode }] : [],
      ),
    ),
    fleet: blocks.some((block) => block.type === 'fleet'),
  };
}

type PreviewNeeds = ReturnType<typeof previewNeeds>;

interface PreviewData {
  key: string;
  stops: SiteStop[] | null;
  departures: Map<string, SiteDeparture[] | null>;
  itineraries: Map<string, ItineraryResult>;
  fleet: SiteVehicle[] | null;
}

/** The planned itinerary of the first bookable journey, as the website reads it. */
async function previewItinerary(journeys: BookingSearchResult[] | null): Promise<ItineraryResult> {
  if (journeys === null) return { status: 'unavailable' };
  const journey = journeys.find((item) => item.origin.plannedDepartureAt !== null);
  if (!journey) return { status: 'none' };
  const result = await auth.booking.public.itinerary(journey.tripId);
  const itinerary = result.ok
    ? journeyItinerary(
        result.data,
        journey.origin.routeWaypointId,
        journey.destination.routeWaypointId,
      )
    : null;
  return itinerary ? { status: 'ok', itinerary } : { status: 'unavailable' };
}

async function loadPreviewData(key: string, needs: PreviewNeeds): Promise<PreviewData> {
  const directions = [...new Set([...needs.departures, ...needs.itineraries])];
  // The stops a block names are resolved exactly, even beyond the first page.
  const codes = [
    ...new Set([
      ...(needs.search ?? []),
      ...directions.flatMap((direction) => direction.split('>')),
    ]),
  ];
  let stops: BookingSearchStop[] | null = null;
  if (codes.length > 0) {
    const [listed, ...named] = await Promise.all([
      auth.booking.public.stops({ limit: 50 }),
      ...codes.map((code) => auth.booking.public.stops({ query: code, limit: 50 })),
    ]);
    if (listed.ok) {
      const byCode = new Map(listed.data.items.map((stop) => [stop.code, stop]));
      codes.forEach((code, index) => {
        const result = named[index];
        const exact = result?.ok ? result.data.items.find((stop) => stop.code === code) : undefined;
        if (exact) byCode.set(exact.code, exact);
      });
      stops = [...byCode.values()];
    }
  }
  const stopOf = (code: string | undefined) => stops?.find((stop) => stop.code === code);
  // One search per direction, shared by the departures and the itinerary.
  const journeys = new Map<string, BookingSearchResult[] | null>();
  await Promise.all(
    directions.map(async (direction) => {
      const [fromCode, toCode] = direction.split('>');
      const origin = stopOf(fromCode);
      const destination = stopOf(toCode);
      if (!origin || !destination) {
        // Unknown stops are not an outage: the direction simply has no journey.
        journeys.set(direction, stops ? [] : null);
        return;
      }
      // Full trips are filtered before the limit, as on the website.
      const result = await auth.booking.public.searchTrips({
        originStopId: origin.id,
        destinationStopId: destination.id,
        minAvailableSeats: 1,
        limit: 12,
      });
      journeys.set(direction, result.ok ? result.data.items : null);
    }),
  );
  const departures = new Map<string, SiteDeparture[] | null>();
  for (const direction of needs.departures) {
    const [fromCode, toCode] = direction.split('>');
    const origin = stopOf(fromCode);
    const destination = stopOf(toCode);
    departures.set(
      direction,
      journeys.get(direction)?.flatMap((item) =>
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
  const [itineraries, fleet] = await Promise.all([
    Promise.all(
      needs.itineraries.map(
        async (direction) =>
          [direction, await previewItinerary(journeys.get(direction) ?? null)] as const,
      ),
    ),
    needs.fleet ? auth.booking.public.fleet() : Promise.resolve(null),
  ]);
  return {
    key,
    stops: stops?.map(siteStopOf) ?? null,
    departures,
    itineraries: new Map(itineraries),
    fleet: fleet?.ok
      ? fleet.data.items.map((vehicle) => ({
          ...vehicle,
          amenities: knownAmenities(vehicle.amenities),
        }))
      : null,
  };
}

/**
 * UI-PUBLIC-1/2: the stops of the hero search, the departures, itineraries
 * and coaches of the page, read from the same public API as the website
 * (never typed in the CMS).
 */
function usePreviewData(page: PageDocument | null) {
  const needs = previewNeeds(page);
  const wanted = JSON.stringify(needs);
  const empty =
    !needs.search &&
    needs.departures.length === 0 &&
    needs.itineraries.length === 0 &&
    !needs.fleet;
  const [loaded, setLoaded] = useState<PreviewData | null>(null);
  useEffect(() => {
    if (empty) return;
    let current = true;
    void loadPreviewData(wanted, JSON.parse(wanted) as PreviewNeeds).then((data) => {
      if (current) setLoaded(data);
    });
    return () => {
      current = false;
    };
  }, [wanted, empty]);
  if (!loaded || loaded.key !== wanted) return { version: '', extra: {} };
  const searchZone = needs.search
    ? loaded.stops?.find((stop) => stop.code === needs.search?.[0])?.timezone
    : undefined;
  return {
    version: loaded.key,
    extra: {
      ...(needs.search && loaded.stops ? { stops: loaded.stops } : {}),
      ...(needs.departures.length > 0
        ? {
            departures: (fromCode: string, toCode: string) =>
              loaded.departures.get(directionKey(fromCode, toCode)) ?? null,
          }
        : {}),
      ...(needs.itineraries.length > 0
        ? {
            itineraries: (fromCode: string, toCode: string): ItineraryResult =>
              loaded.itineraries.get(directionKey(fromCode, toCode)) ?? { status: 'unavailable' },
          }
        : {}),
      ...(needs.fleet ? { fleet: loaded.fleet } : {}),
      // The first selectable date, in the origin's timezone like the booking search.
      today: localDate(new Date().toISOString(), searchZone ?? 'Europe/Paris'),
    } satisfies Partial<SiteContext>,
  };
}

/**
 * Exact rendering of the website (same components, same stylesheets) in a
 * sandboxed frame without scripts nor origin: nothing in the preview can
 * act on OPS, and its links lead nowhere. Images load from the API origin
 * (CSP img-src, Cross-Origin-Resource-Policy on the files).
 */
export function ContentPreview({
  kind,
  document,
  site,
}: {
  kind: ContentKind;
  document: unknown;
  site: PreviewSite;
}) {
  const [viewport, setViewport] = useState<ViewportKey>('mobile');
  const [html, setHtml] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const media = useMediaCache();
  const pageForTrips =
    kind === 'PAGE' ? (pageDocumentSchema.safeParse(document).data ?? null) : null;
  const trips = usePreviewData(pageForTrips);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setBoxWidth(entry?.contentRect.width ?? 0));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const model = previewModel(kind, document, site);
    if (!model) {
      setStale(true);
      return;
    }
    media.cache.request(mediaIdsOf(model.page));
    const ctx: SiteContext = {
      ...model.ctx,
      ...trips.extra,
      media: (id) => media.cache.get(id) ?? null,
    };
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all([import('react-dom/server'), import('@euroteranga/site/css-text')]).then(
        ([{ renderToStaticMarkup }, { SITE_CSS }]) => {
          if (cancelled) return;
          const body = renderToStaticMarkup(
            <SitePage
              title={model.page.title}
              blocks={model.page.blocks}
              ctx={ctx}
              banner={
                <p className="public-preview-notice" role="note">
                  Aperçu — version non publiée
                </p>
              }
            />,
          );
          setHtml(
            `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Aperçu</title><style>${SITE_CSS}</style><style>.public-preview-notice{margin:0;padding:.5rem 1rem;background:#1b1d1c;color:#fff;font:600 .875rem/1.4 system-ui,sans-serif;text-align:center}</style></head><body>${body}</body></html>`,
          );
          setStale(false);
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `media.version` re-renders once newly referenced images are resolved.
    // `trips.version` re-renders once the stops, departures, itineraries and
    // coaches are read.
  }, [kind, document, site, media.version, trips.version]);

  const width = VIEWPORTS.find((item) => item.key === viewport)!.width;
  const scale = boxWidth > 0 && boxWidth < width ? boxWidth / width : 1;
  const height = 720;

  return (
    <section className="ops-content-preview" aria-labelledby="content-preview-title">
      <div className="ops-content-preview__bar">
        <h3 id="content-preview-title">Aperçu</h3>
        <div role="group" aria-label="Largeur de l’aperçu" className="ops-content-preview__sizes">
          {VIEWPORTS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={item.key === viewport ? 'et-button' : 'et-button et-button--secondary'}
              aria-pressed={item.key === viewport}
              onClick={() => setViewport(item.key)}
            >
              {item.label} <span className="ops-content-count">{item.width} px</span>
            </button>
          ))}
        </div>
      </div>
      {stale ? (
        <p className="ops-content-warning" role="status">
          Aperçu figé : corrigez les champs signalés pour le mettre à jour.
        </p>
      ) : null}
      <p className="et-hint">
        Les prix « à partir de » viennent de la tarification et n’apparaissent que sur le site.
        Départs, itinéraires et autocars sont lus en direct sur la réservation et la flotte.
      </p>
      <div ref={boxRef} className="ops-content-preview__box" style={{ height: height * scale }}>
        {html ? (
          <iframe
            title="Aperçu de la page telle que le site l’affichera"
            sandbox=""
            srcDoc={html}
            style={{
              width,
              height,
              transform: scale < 1 ? `scale(${scale})` : undefined,
              transformOrigin: 'top left',
            }}
            data-testid="content-preview-frame"
          />
        ) : (
          <p role="status">Préparation de l’aperçu…</p>
        )}
      </div>
    </section>
  );
}
