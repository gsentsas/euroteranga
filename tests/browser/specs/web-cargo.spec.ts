import { expect, test, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { cargoPageSeed } from '../content-seed.js';

const web = appByName('web');

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('public cargo and freight page (WEB-CARGO-1)', () => {
  test('renders /fret as a responsive editorial page without public cargo transactions', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { path } = cargoPageSeed();

    const response = await page.goto(appUrl(web, path));
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/Colis & fret Paris ↔ Dakar — EURO TERANGA/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `http://localhost:3000${path}`,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      'Envoyez vos colis et votre fret routier entre Paris et Dakar avec EURO TERANGA : prise en charge, suivi sécurisé et devis adapté à votre envoi.',
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      'Colis & fret Paris ↔ Dakar — EURO TERANGA',
    );
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      'content',
      'summary_large_image',
    );

    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Envoyez vos colis entre Paris et Dakar',
    );
    const tabs = page.getByRole('navigation', { name: 'Sur cette page' });
    for (const [label, anchor] of [
      ['Services', 'services'],
      ['Fonctionnement', 'fonctionnement'],
      ['Directions', 'directions'],
      ['Suivi', 'suivi'],
      ['Questions', 'questions'],
    ] as const) {
      await expect(tabs.getByRole('link', { name: label })).toHaveAttribute('href', `#${anchor}`);
      await expect(page.locator(`#${anchor}`)).toHaveCount(1);
    }
    await tabs.getByRole('link', { name: 'Suivi' }).click();
    await expect(page).toHaveURL(/#suivi$/);
    await expect(page.locator('#suivi').getByRole('heading')).toBeInViewport();

    await expect(
      page.getByRole('heading', { name: 'Une prise en charge adaptée à votre envoi.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Votre envoi, étape par étape.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Entre Paris et Dakar, dans les deux sens.' }),
    ).toBeVisible();
    await expect(page.locator('#suivi')).toContainText(
      'Un accès transmis uniquement lorsqu’il est activé.',
    );
    await expect(page.locator('#questions details')).toHaveCount(6);
    await expect(page.getByRole('link', { name: 'Demander un devis' }).first()).toHaveAttribute(
      'href',
      '#questions',
    );
    await expect(page.getByRole('link', { name: 'Comment fonctionne le suivi ?' })).toHaveAttribute(
      'href',
      '#suivi',
    );

    const main = await page.getByRole('main').textContent();
    expect(main).not.toMatch(/\d+(?:[.,]\d+)?\s*(?:€|euros?|francs?|kg|m(?:³|3))\b/i);
    expect(main).not.toMatch(/€\s*\d|\/(?:kg|m(?:³|3))/i);
    expect(main).not.toMatch(/\bETC-[A-Z0-9-]+\b/);
    expect(main).not.toMatch(
      /senderName|senderContact|recipientName|recipientContact|customerIdentityId|bookingReference|declaredContents|declaredValue|dimensions|actorId|vehicleId|trackingCode|cargoId|publicToken|latitude|longitude/i,
    );
    await expect(page.getByRole('main').locator('form, input, textarea, select')).toHaveCount(0);
    await expect(page.getByRole('main').locator('a[href*="booking"]')).toHaveCount(0);
    const structured = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(structured.join(' ')).not.toMatch(
      /AggregateOffer|"Offer"|priceCurrency|lowPrice|highPrice/i,
    );

    await expectNoHorizontalOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  test('includes only the published, indexable cargo page in the sitemap', async ({
    page,
    request,
  }) => {
    const seed = cargoPageSeed();
    const response = await request.get(appUrl(web, '/sitemap.xml'));
    expect(response.status()).toBe(200);
    const sitemap = await response.text();
    expect(sitemap).toContain(`<loc>http://localhost:3000${seed.path}</loc>`);
    expect(sitemap).not.toContain(seed.draftPath);
    expect(sitemap).not.toContain(seed.archivedPath);
    expect(sitemap).not.toContain(seed.noIndexPath);

    for (const hidden of [seed.draftPath, seed.archivedPath]) {
      const hiddenResponse = await page.goto(appUrl(web, hidden));
      expect(hiddenResponse?.status(), hidden).toBe(404);
    }
  });
});
