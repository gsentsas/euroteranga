import { loadSiteSeo, robotsDirective, type SiteSeo } from '@euroteranga/config';

/**
 * Runtime SEO configuration of the public website. Pages are rendered on
 * the server for each request, so `SEO_INDEXING_ENABLED` and
 * `PUBLIC_SITE_URL` come from the running service environment and a change
 * needs a restart, not a new build.
 */
export function siteSeo(): SiteSeo {
  return loadSiteSeo({
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL,
    SEO_INDEXING_ENABLED: process.env.SEO_INDEXING_ENABLED,
  });
}

export const SITE_NAME = 'EURO TERANGA';
export const DEFAULT_TITLE = 'EURO TERANGA — Autocar Paris ↔ Dakar';
export const DEFAULT_DESCRIPTION =
  'Voyagez en autocar entre Paris et Dakar avec EURO TERANGA : réservation en ligne, choix du siège, bagages identifiés et suivi du trajet.';

/** JSON-LD for a <script type="application/ld+json">, safe to embed in HTML. */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Robots meta directive consistent with robots.txt (fail-closed). */
export function robotsOf(seo: SiteSeo) {
  return robotsDirective(seo);
}

/**
 * Open Graph and Twitter fields shared by every page. A page's `openGraph`
 * replaces the layout's instead of merging with it, so each page spreads
 * these and only adds its own title, description and URL.
 */
export const SOCIAL_IMAGE = {
  url: '/opengraph-image',
  width: 1200,
  height: 630,
  alt: 'EURO TERANGA — autocar Paris ↔ Dakar',
};

export function openGraphBase() {
  return {
    type: 'website' as const,
    locale: 'fr_FR',
    siteName: SITE_NAME,
    images: [SOCIAL_IMAGE],
  };
}

export function twitterBase() {
  return { card: 'summary_large_image' as const, images: ['/twitter-image'] };
}
