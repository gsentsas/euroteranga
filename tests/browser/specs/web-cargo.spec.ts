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
  test('renders /fret with a fail-closed public cargo calculator', async ({ page }) => {
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

    const calculator = page.getByRole('heading', { name: 'Calculez le prix de votre envoi' });
    await expect(calculator).toBeVisible();
    await page.getByLabel('Poids').fill('25');
    await page.getByLabel('Type d’envoi').selectOption('STANDARD_PARCEL');
    await page.getByRole('button', { name: 'Calculer mon tarif' }).click();
    await expect(
      page.getByRole('heading', { name: 'Devis personnalisé nécessaire' }),
    ).toBeVisible();
    await expect(
      page.getByText('Aucun tarif automatique ne peut être confirmé pour cet envoi.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Demander un devis' }).last()).toHaveAttribute(
      'href',
      /^(mailto:|#questions)/,
    );

    const main = await page.getByRole('main').textContent();
    expect(main).not.toMatch(/\bETC-[A-Z0-9-]+\b/);
    expect(main).not.toMatch(
      /senderName|senderContact|recipientName|recipientContact|customerIdentityId|bookingReference|declaredContents|declaredValue|actorId|vehicleId|trackingCode|cargoId|publicToken|latitude|longitude/i,
    );
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

  test('renders only the exact price returned by the cargo pricing API', async ({ page }) => {
    await page.route('**/v1/cargo/estimate', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          direction: 'PAR_DKR',
          from: 'PAR',
          to: 'DKR',
          category: 'STANDARD_PARCEL',
          actualWeightKg: '25.000',
          volumeM3: null,
          requiresQuote: false,
          quoteReason: null,
          currencyCode: 'EUR',
          currencyMinorUnit: 2,
          totalMinor: '7500',
          pricingVersion: 'TEST_PUBLIC:v1',
          effectiveFrom: '2026-10-24T00:00:00.000Z',
          calculation: {
            method: 'ACTUAL_WEIGHT',
            actualWeightKg: '25.000',
            volumetricWeightKg: null,
            billableWeightKg: '25.000',
            volumeM3: null,
            unitPriceMinor: '300',
            baseAmountMinor: '7500',
            minimumApplied: false,
            tierPosition: null,
          },
          lines: [{ kind: 'BASE', code: 'BASE', amountMinor: '7500' }],
          includedOptions: [],
        }),
      });
    });

    const { path } = cargoPageSeed();
    await page.goto(appUrl(web, path));
    await page.getByLabel('Poids').fill('25');
    await page.getByRole('button', { name: 'Calculer mon tarif' }).click();
    await expect(page.getByRole('heading', { name: '75,00 EUR' })).toBeVisible();
    await expect(page.getByText('Paris → Dakar · 25.000 kg')).toBeVisible();
    await expect(page.getByText('Tarif calculé selon la grille active.')).toBeVisible();
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

    const noIndexResponse = await page.goto(appUrl(web, seed.noIndexPath));
    expect(noIndexResponse?.status()).toBe(200);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow');

    for (const hidden of [seed.draftPath, seed.archivedPath]) {
      const hiddenResponse = await page.goto(appUrl(web, hidden));
      expect(hiddenResponse?.status(), hidden).toBe(404);
    }
  });
});
