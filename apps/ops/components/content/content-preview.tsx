'use client';

import {
  DEFAULT_HOME_PAGE,
  DEFAULT_NAVIGATION,
  DEFAULT_SITE_SETTINGS,
  navigationSchema,
  pageDocumentSchema,
  siteSettingsSchema,
  type ContentKind,
  type Navigation,
  type PageDocument,
  type SiteSettings,
} from '@euroteranga/content';
import { SitePage, type SiteContext } from '@euroteranga/site';
import { useEffect, useRef, useState } from 'react';

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
 * Exact rendering of the website (same components, same stylesheets) in a
 * sandboxed frame without scripts nor origin: nothing in the preview can
 * act on OPS, and its links lead nowhere.
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
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all([import('react-dom/server'), import('@euroteranga/site/css-text')]).then(
        ([{ renderToStaticMarkup }, { SITE_CSS }]) => {
          if (cancelled) return;
          const body = renderToStaticMarkup(
            <SitePage
              title={model.page.title}
              blocks={model.page.blocks}
              ctx={model.ctx}
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
  }, [kind, document, site]);

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
