import { expect, test } from '@playwright/test';
import { appByName, appUrl, frontendApps } from '../apps.js';

const web = appByName('web');
const SITE = 'http://localhost:3000';

/**
 * SEO-1: outside production with explicit opt-in, nothing is indexable. The
 * browser job runs with NEXT_PUBLIC_APP_ENV=ci, so the public website must
 * be closed to crawlers while still exposing correct metadata.
 */
test.describe('SEO of the public website (CI: never indexable)', () => {
  test('robots.txt disallows everything and no sitemap is advertised', async ({ request }) => {
    const response = await request.get(appUrl(web, '/robots.txt'));
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/plain');
    const body = await response.text();
    expect(body).toMatch(/User-Agent: \*\s+Disallow: \//);
    expect(body).not.toContain('Sitemap:');
  });

  test('the homepage carries canonical, social and noindex metadata', async ({ page }) => {
    await page.goto(appUrl(web));
    await expect(page).toHaveTitle('EURO TERANGA — Autocar Paris ↔ Dakar');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      /noindex, nofollow/,
    );
    // Next.js writes the root canonical URL without its trailing slash.
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', SITE);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /Paris et Dakar/,
    );
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'fr_FR');
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      'content',
      'summary_large_image',
    );
    await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', /icon\.svg/);
    const image = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(image).toMatch(/^http:\/\/localhost:3000\/opengraph-image/);
  });

  test('the social image is a real PNG served by the site', async ({ page, request }) => {
    await page.goto(appUrl(web));
    const image = (await page.locator('meta[property="og:image"]').getAttribute('content')) ?? '';
    const response = await request.get(appUrl(web, new URL(image).pathname));
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('image/png');
    expect((await response.body()).subarray(1, 4).toString()).toBe('PNG');
  });

  test('structured data declares the organization and website only', async ({ page }) => {
    await page.goto(appUrl(web));
    const raw = await page.locator('script[type="application/ld+json"]').textContent();
    const data = JSON.parse(raw ?? '[]') as Array<Record<string, unknown>>;
    expect(data.map((item) => item['@type'])).toEqual(['Organization', 'WebSite']);
    expect(data[0]).toMatchObject({ name: 'EURO TERANGA', url: `${SITE}/` });
    expect(JSON.stringify(data)).not.toMatch(/aggregateRating|review|offers|price/i);
  });

  test('sitemap.xml lists the public pages on the canonical origin', async ({ request }) => {
    const response = await request.get(appUrl(web, '/sitemap.xml'));
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain(`<loc>${SITE}/</loc>`);
    expect(body).not.toMatch(/booking|client|tracking|ops|crew/);
  });

  test('an unknown page is a French 404 with a way back', async ({ page }) => {
    const response = await page.goto(appUrl(web, '/page-qui-n-existe-pas'));
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Cette page n’existe pas ou a été déplacée.',
    );
    await expect(page.getByRole('link', { name: 'Retour à l’accueil' })).toHaveAttribute(
      'href',
      '/',
    );
    // Next.js adds its own `noindex` to not-found responses, next to the site directive.
    const directives = await page
      .locator('meta[name="robots"]')
      .evaluateAll((metas) => metas.map((meta) => meta.getAttribute('content') ?? ''));
    expect(directives.length).toBeGreaterThan(0);
    for (const directive of directives) expect(directive).toContain('noindex');
  });
});

test.describe('SEO of the private applications', () => {
  for (const app of frontendApps.filter((candidate) => candidate.name !== 'web')) {
    test(`${app.name}: robots.txt disallows everything`, async ({ request }) => {
      const response = await request.get(appUrl(app, '/robots.txt'));
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('text/plain');
      expect(await response.text()).toMatch(/User-Agent: \*\s+Disallow: \//);
    });

    test(`${app.name}: an unknown page is a French 404`, async ({ page }) => {
      const response = await page.goto(appUrl(app, '/zz-introuvable/page'));
      expect(response?.status()).toBe(404);
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
      await expect(page.getByRole('main')).toContainText(/n’existe pas/);
    });
  }

  test('tracking: a malformed token is a 404 that never reaches the API', async ({ page }) => {
    const apiCalls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/v1/tracking/')) apiCalls.push(request.url());
    });
    const response = await page.goto(appUrl(appByName('tracking'), '/not-a-valid-token'));
    expect(response?.status()).toBe(404);
    await page.waitForLoadState('networkidle');
    expect(apiCalls).toEqual([]);
  });
});
