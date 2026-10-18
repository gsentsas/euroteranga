import { ConfigValidationError } from './errors.js';

/**
 * SEO configuration of the public website, read on the server at request
 * time (never inlined in browser code):
 *
 * - `PUBLIC_SITE_URL`: canonical origin of the public website. Default:
 *   https://euroteranga.com when deployed (staging, which is the current
 *   pilot, and production), http://localhost:3000 locally and in CI. HTTPS
 *   is required in staging and production.
 * - `SEO_INDEXING_ENABLED`: indexing is allowed only when it is exactly
 *   `true` **and** the app environment is `production`. Any other value,
 *   environment or omission keeps the site out of search engines
 *   (fail-closed).
 */
export interface SiteSeo {
  appEnv: string;
  siteUrl: URL;
  indexable: boolean;
}

const DEPLOYED = new Set(['staging', 'production']);

export function loadSiteSeo(env: Record<string, string | undefined>): SiteSeo {
  const appEnv = env.NEXT_PUBLIC_APP_ENV ?? 'local';
  const raw =
    env.PUBLIC_SITE_URL?.trim() ||
    (DEPLOYED.has(appEnv) ? 'https://euroteranga.com' : 'http://localhost:3000');
  let siteUrl: URL;
  try {
    siteUrl = new URL(raw);
  } catch {
    throw new ConfigValidationError('public website (SEO)', ['PUBLIC_SITE_URL: must be a URL']);
  }
  const problems: string[] = [];
  if (siteUrl.protocol !== 'https:' && siteUrl.protocol !== 'http:') {
    problems.push('PUBLIC_SITE_URL: must use http or https');
  }
  if (DEPLOYED.has(appEnv) && siteUrl.protocol !== 'https:') {
    problems.push('PUBLIC_SITE_URL: must use https in staging and production');
  }
  if (siteUrl.pathname !== '/' || siteUrl.search || siteUrl.hash || siteUrl.username) {
    problems.push('PUBLIC_SITE_URL: must be an origin, without path, query or credentials');
  }
  if (problems.length > 0) throw new ConfigValidationError('public website (SEO)', problems);
  return {
    appEnv,
    siteUrl,
    indexable: appEnv === 'production' && env.SEO_INDEXING_ENABLED === 'true',
  };
}

/** Absolute URL of a public path on the canonical origin. */
export function siteUrlOf(seo: SiteSeo, path: string): string {
  return new URL(path, seo.siteUrl).toString();
}

/** robots.txt of the public website (Next.js MetadataRoute.Robots shape). */
export function publicRobots(seo: SiteSeo) {
  if (!seo.indexable) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: siteUrlOf(seo, '/sitemap.xml'),
    host: seo.siteUrl.origin,
  };
}

/** robots.txt of the private applications (Booking, Client, Tracking, OPS, Crew). */
export function privateRobots() {
  return { rules: [{ userAgent: '*', disallow: '/' }] };
}

/** The robots meta directive matching the robots.txt decision. */
export function robotsDirective(seo: SiteSeo) {
  return seo.indexable
    ? { index: true, follow: true }
    : { index: false, follow: false, nocache: true };
}
