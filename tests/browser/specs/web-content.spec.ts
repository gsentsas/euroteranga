import { expect, test } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { contentSeed } from '../content-seed.js';

const web = appByName('web');

/**
 * WEB-1: the public website renders the published CMS content on the server,
 * falls back to the default content for the home page, takes prices from
 * Pricing only, and treats editor text as text.
 */
test.describe('public website content (CMS)', () => {
  test('renders a published CMS page with its metadata and canonical path', async ({ page }) => {
    const { path, title } = contentSeed();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const response = await page.goto(appUrl(web, path));
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(`${title} — EURO TERANGA`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Contenu publié' })).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `http://localhost:3000${path}`,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      'Page de démonstration publiée pour les tests navigateur.',
    );
    // Markup typed by an editor is shown as text, never interpreted.
    await expect(page.getByText('<b>Le balisage reste du texte.</b>')).toBeVisible();
    await expect(page.locator('main b')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Rechercher un voyage' })).toHaveAttribute(
      'href',
      'https://booking.euroteranga.com/',
    );
    expect(errors).toEqual([]);
  });

  test('serves the home page from the default content while nothing is published', async ({
    page,
  }) => {
    await page.goto(appUrl(web));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Voyagez entre l’Europe et l’Afrique en toute confiance',
    );
    await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toContainText(
      'Trajets',
    );
    await expect(page.locator('#trajets')).toBeVisible();
    await expect(page.locator('#aide details').first()).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText('EURO TERANGA');
  });

  test('lists published pages in the sitemap and answers 404 for unknown pages', async ({
    page,
    request,
  }) => {
    const { path } = contentSeed();
    const sitemap = await (await request.get(appUrl(web, '/sitemap.xml'))).text();
    expect(sitemap).toContain(`<loc>http://localhost:3000${path}</loc>`);
    expect(sitemap).toContain('<loc>http://localhost:3000/</loc>');

    for (const unknown of ['/page-inconnue', '/Majuscules', '/a/b/c/d/e']) {
      const response = await page.goto(appUrl(web, unknown));
      expect(response?.status(), unknown).toBe(404);
    }
  });
});
