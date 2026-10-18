import { describe, expect, it } from 'vitest';
import { ConfigValidationError } from './errors.js';
import { loadSiteSeo, privateRobots, publicRobots, robotsDirective, siteUrlOf } from './seo.js';

describe('public website SEO configuration', () => {
  it('defaults to a non-indexable local site', () => {
    const seo = loadSiteSeo({});
    expect(seo).toMatchObject({ appEnv: 'local', indexable: false });
    expect(seo.siteUrl.toString()).toBe('http://localhost:3000/');
  });

  it('defaults to the brand origin when deployed, still not indexable', () => {
    for (const appEnv of ['staging', 'production']) {
      const seo = loadSiteSeo({ NEXT_PUBLIC_APP_ENV: appEnv });
      expect(seo.siteUrl.origin, appEnv).toBe('https://euroteranga.com');
      expect(seo.indexable, appEnv).toBe(false);
    }
  });

  it('indexes only production with SEO_INDEXING_ENABLED exactly "true"', () => {
    expect(
      loadSiteSeo({ NEXT_PUBLIC_APP_ENV: 'production', SEO_INDEXING_ENABLED: 'true' }).indexable,
    ).toBe(true);
    for (const value of ['TRUE', '1', 'yes', 'false', ' true', '']) {
      expect(
        loadSiteSeo({ NEXT_PUBLIC_APP_ENV: 'production', SEO_INDEXING_ENABLED: value }).indexable,
        JSON.stringify(value),
      ).toBe(false);
    }
    for (const appEnv of ['local', 'ci', 'staging']) {
      expect(
        loadSiteSeo({
          NEXT_PUBLIC_APP_ENV: appEnv,
          SEO_INDEXING_ENABLED: 'true',
          PUBLIC_SITE_URL: 'https://staging.example',
        }).indexable,
        appEnv,
      ).toBe(false);
    }
  });

  it('requires an https origin in staging and production', () => {
    expect(() =>
      loadSiteSeo({ NEXT_PUBLIC_APP_ENV: 'production', PUBLIC_SITE_URL: 'http://euroteranga.com' }),
    ).toThrow(ConfigValidationError);
    for (const url of [
      'https://euroteranga.com/fr',
      'https://euroteranga.com/?a=1',
      'ftp://x',
      'nope',
    ]) {
      expect(() => loadSiteSeo({ PUBLIC_SITE_URL: url }), url).toThrow(ConfigValidationError);
    }
    const seo = loadSiteSeo({ PUBLIC_SITE_URL: 'https://www.example.org' });
    expect(siteUrlOf(seo, '/paris-dakar')).toBe('https://www.example.org/paris-dakar');
  });

  it('keeps robots.txt and the robots meta directive consistent', () => {
    const closed = loadSiteSeo({ NEXT_PUBLIC_APP_ENV: 'production' });
    expect(publicRobots(closed)).toEqual({ rules: [{ userAgent: '*', disallow: '/' }] });
    expect(robotsDirective(closed)).toEqual({ index: false, follow: false, nocache: true });

    const open = loadSiteSeo({ NEXT_PUBLIC_APP_ENV: 'production', SEO_INDEXING_ENABLED: 'true' });
    expect(publicRobots(open)).toEqual({
      rules: [{ userAgent: '*', allow: '/' }],
      sitemap: 'https://euroteranga.com/sitemap.xml',
      host: 'https://euroteranga.com',
    });
    expect(robotsDirective(open)).toEqual({ index: true, follow: true });
    expect(privateRobots()).toEqual({ rules: [{ userAgent: '*', disallow: '/' }] });
  });
});
