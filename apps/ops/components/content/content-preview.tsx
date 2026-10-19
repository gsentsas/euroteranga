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
import type { BookingSearchStop } from '@euroteranga/auth-client';
import {
  createMediaCache,
  directionKey,
  localDate,
  SitePage,
  siteMediaOf,
  type SiteContext,
  type SiteDeparture,
  type SiteMedia,
  type SiteStop,
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

/**
 * UI-PUBLIC-1: the stops of the hero search and the departures of the page,
 * read from the same public API as the website (never typed in the CMS).
 */
function usePreviewTrips(page: PageDocument | null) {
  const routes = (page?.blocks ?? []).flatMap((block) =>
    block.type === 'departures' ? block.routes : [],
  );
  const hero = (page?.blocks ?? []).find((block) => block.type === 'hero');
  const search = hero?.search !== undefined;
  const searchCodes = hero?.search ? [hero.search.fromCode, hero.search.toCode] : [];
  const wanted = `${search ? `search:${searchCodes.join('>')};` : ''}${routes
    .map((route) => directionKey(route.fromCode, route.toCode))
    .join(',')}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    stops: SiteStop[] | undefined;
    departures: Map<string, SiteDeparture[] | null>;
  } | null>(null);
  useEffect(() => {
    if (wanted === '') return;
    let current = true;
    void (async () => {
      // The stops a block names are resolved exactly, even beyond the first page.
      const codes = [
        ...new Set(
          wanted
            .replace(/^search:[^;]*;/, '')
            .split(/[,>]/)
            .filter(Boolean)
            .concat(search ? searchCodes : []),
        ),
      ];
      const [listed, ...named] = await Promise.all([
        auth.booking.public.stops({ limit: 50 }),
        ...codes.map((code) => auth.booking.public.stops({ query: code, limit: 50 })),
      ]);
      const byCode = new Map(listed.ok ? listed.data.items.map((stop) => [stop.code, stop]) : []);
      codes.forEach((code, index) => {
        const result = named[index];
        const exact = result?.ok ? result.data.items.find((stop) => stop.code === code) : undefined;
        if (exact) byCode.set(exact.code, exact);
      });
      const stops = listed.ok ? [...byCode.values()] : null;
      const departures = new Map<string, SiteDeparture[] | null>();
      await Promise.all(
        wanted
          .replace(/^search:[^;]*;/, '')
          .split(',')
          .filter(Boolean)
          .map(async (key) => {
            const [fromCode, toCode] = key.split('>');
            const origin = stops?.find((stop) => stop.code === fromCode);
            const destination = stops?.find((stop) => stop.code === toCode);
            if (!origin || !destination) {
              departures.set(key, stops ? [] : null);
              return;
            }
            const result = await auth.booking.public.searchTrips({
              originStopId: origin.id,
              destinationStopId: destination.id,
              limit: 12,
            });
            departures.set(
              key,
              result.ok
                ? result.data.items.flatMap((item) =>
                    item.origin.plannedDepartureAt
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
                  )
                : null,
            );
          }),
      );
      if (current) {
        setLoaded({ key: wanted, stops: stops?.map(siteStopOf), departures });
      }
    })();
    return () => {
      current = false;
    };
  }, [wanted]);
  if (!loaded || loaded.key !== wanted) return { version: '', extra: {} };
  return {
    version: loaded.key,
    extra: {
      ...(search && loaded.stops ? { stops: loaded.stops } : {}),
      ...(routes.length > 0
        ? {
            departures: (fromCode: string, toCode: string) =>
              loaded.departures.get(directionKey(fromCode, toCode)) ?? null,
          }
        : {}),
      today: localDate(new Date().toISOString(), 'Europe/Paris'),
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
  const trips = usePreviewTrips(pageForTrips);

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
    // `trips.version` re-renders once the stops and departures are read.
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
