import { expect, test, type Page } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { pagesSeed } from '../content-seed.js';

const web = appByName('web');

/** Core structural UX invariants shared by the seeded public pages. */
async function expectPublicPageStructure(page: Page) {
  const structure = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll<HTMLElement>('[id]'))
      .map((element) => element.id)
      .filter(Boolean);

    return {
      duplicateIds: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))],
      missingImageAlt: Array.from(
        document.querySelectorAll<HTMLImageElement>('img:not([alt])'),
      ).map((image) => image.currentSrc || image.src || '<inline image>'),
      mainCount: document.querySelectorAll('main').length,
      h1Count: document.querySelectorAll('h1').length,
      horizontalOverflow: Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    };
  });

  expect(structure.duplicateIds).toEqual([]);
  expect(structure.missingImageAlt).toEqual([]);
  expect(structure.mainCount).toBe(1);
  expect(structure.h1Count).toBe(1);
  expect(structure.horizontalOverflow).toBeLessThanOrEqual(1);
}

/**
 * UI-PUBLIC-2: the inner pages read real data. Dates, fares and seats come
 * from the public trip search (Pricing), the itinerary from the next
 * bookable trip (local times, border crossing, technical stops kept
 * internal), and the coaches and their equipment from Fleet.
 */
test.describe('public inner pages (UI-PUBLIC-2)', () => {
  test('a trip page lists real dates and the planned itinerary of the next departure', async ({
    page,
  }) => {
    const seed = pagesSeed();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    const response = await page.goto(appUrl(web, seed.trip.path));
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(seed.trip.title);
    await expectPublicPageStructure(page);
    const breadcrumb = page.getByRole('navigation', { name: 'Fil d’Ariane' });
    await expect(breadcrumb.getByRole('link', { name: 'Accueil' })).toHaveAttribute('href', '/');
    await expect(breadcrumb.locator('[aria-current="page"]')).toContainText(seed.trip.title);
    const structured = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(structured.some((text) => text.includes('"BreadcrumbList"'))).toBe(true);

    // Both scheduled trips, soonest first, with the exact Pricing fare.
    const dates = page.locator('.public-dates > li');
    await expect(dates).toHaveCount(2);
    await expect(dates.first()).toContainText('10 juil.');
    await expect(dates.first()).toContainText('08:30');
    await expect(dates.first()).toContainText(/249\s€/);
    await expect(dates.nth(1)).toContainText('24 juil.');
    const book = page.getByRole('link', { name: /^Réserver ce voyage/ });
    const href = new URL((await book.getAttribute('href')) ?? '');
    expect(Object.fromEntries(href.searchParams)).toEqual({
      from: seed.originCode,
      to: seed.destinationCode,
      date: '2030-07-10',
    });

    // The section tabs land below the sticky header and tabs.
    const tabs = page.getByRole('navigation', { name: 'Sur cette page' });
    await tabs.getByRole('link', { name: 'Itinéraire' }).click();
    await expect(page).toHaveURL(/#itineraire$/);
    const itinerary = page.locator('#itineraire');
    const heading = itinerary.getByRole('heading', { level: 2 });
    await expect(heading).toBeInViewport();
    const tabsBox = await tabs.boundingBox();
    const headingBox = await heading.boundingBox();
    expect(headingBox!.y).toBeGreaterThanOrEqual(tabsBox!.y + tabsBox!.height - 1);

    // Local times of each place, the "+1 day" arrival and the duration.
    await expect(itinerary).toContainText('08:30');
    await expect(itinerary).toContainText('22:15');
    await expect(itinerary).toContainText('(+1 jour)');
    await expect(itinerary).toContainText('Durée prévue : 39 h 45');
    await expect(itinerary).toContainText('1 arrêt et 1 passage en cours de route');
    await itinerary.getByText('Voir le détail').click();
    await expect(itinerary).toContainText('Passage de frontière : Frontière');
    // Technical checkpoints stay internal.
    await expect(page.locator('body')).not.toContainText('Aire technique interne');

    // What is included: the editor's confirmed service and the coach's real equipment.
    const included = itinerary.getByRole('heading', { name: 'Inclus dans votre voyage' });
    await expect(included).toBeVisible();
    for (const label of ['Service confirmé de démonstration', 'Climatisation', 'Prises USB']) {
      await expect(itinerary).toContainText(label);
    }
    await expect(itinerary).not.toContainText('Wi-Fi');
    await expect(itinerary).toContainText(
      `Équipements de l’autocar ${seed.coaches[0]!.name}, prévu pour ce départ.`,
    );

    // The coach of the page, from Fleet.
    const coaches = page.locator('#autocars');
    await expect(coaches.getByRole('heading', { name: seed.coaches[0]!.name })).toBeVisible();
    await expect(coaches).toContainText('6 places');
    await expect(coaches).not.toContainText(seed.coaches[1]!.name);

    await page.setViewportSize({ width: 400, height: 844 });
    await expectPublicPageStructure(page);
    expect(errors).toEqual([]);
  });

  test('the coaches page shows each active coach with only its own equipment', async ({ page }) => {
    const seed = pagesSeed();
    const response = await page.goto(appUrl(web, seed.fleet.path));
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(seed.fleet.title);
    await expectPublicPageStructure(page);

    const tabs = page.getByRole('navigation', { name: /accès direct/ });
    await expect(tabs.getByRole('link')).toHaveText(seed.coaches.map((coach) => coach.name));
    await tabs.getByRole('link', { name: seed.coaches[1]!.name }).click();
    await expect(page).toHaveURL(new RegExp(`#autocar-${seed.coaches[1]!.code.toLowerCase()}$`));

    const [first, second] = seed.coaches.map((coach) =>
      page.getByRole('article', { name: coach.name }),
    );
    await expect(first!).toContainText('Constructeur synthétique Autocar pages · 2024');
    await expect(first!).toContainText('Description éditoriale.');
    const firstFacts = first!.getByRole('list', {
      name: `Équipements de ${seed.coaches[0]!.name}`,
    });
    await expect(firstFacts.getByRole('listitem')).toHaveText([
      '6 places',
      'Climatisation',
      'Prises USB',
      'Toilettes',
    ]);
    const secondFacts = second!.getByRole('list', {
      name: `Équipements de ${seed.coaches[1]!.name}`,
    });
    await expect(secondFacts.getByRole('listitem')).toHaveText(['6 places', 'Wi-Fi à bord']);
    // Public facts only.
    await expect(page.locator('main')).not.toContainText(/VIN|immatriculation/i);

    await page.setViewportSize({ width: 400, height: 844 });
    await expectPublicPageStructure(page);
  });

  test('the services page renders the page hero and the service cards', async ({ page }) => {
    const seed = pagesSeed();
    const response = await page.goto(appUrl(web, seed.services.path));
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `${seed.services.title} pour un voyage serein`,
    );
    await expectPublicPageStructure(page);
    await expect(page.getByRole('heading', { level: 3, name: 'Bagages identifiés' })).toBeVisible();
    await page.setViewportSize({ width: 400, height: 844 });
    await expectPublicPageStructure(page);
  });
});


test.describe('public help pages (WEB-2A)', () => {
  const pages = [
    { path: '/bagages', heading: 'Préparez vos bagages' },
    { path: '/comment-ca-marche', heading: 'Comment ça marche' },
    { path: '/faq', heading: 'Questions fréquentes' },
    { path: '/a-propos', heading: 'À propos d’EURO TERANGA' },
  ] as const;

  for (const item of pages) {
    test(`${item.path} renders the real CMS template at desktop and 400 px`, async ({ page }) => {
      const response = await page.goto(appUrl(web, item.path));
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(item.heading);
      await expectPublicPageStructure(page);

      const structured = await page.locator('script[type="application/ld+json"]').allTextContents();
      if (item.path === '/faq') {
        expect(structured.some((text) => text.includes('"FAQPage"'))).toBe(true);
      } else {
        expect(structured.some((text) => text.includes('"FAQPage"'))).toBe(false);
      }

      await page.setViewportSize({ width: 400, height: 844 });
      await expectPublicPageStructure(page);
    });
  }

  test('the baggage page does not invent an allowance, weight or public amount', async ({ page }) => {
    await page.goto(appUrl(web, '/bagages'));
    const text = await page.locator('main').innerText();
    expect(text).toContain('ne fixe ni franchise, ni poids maximal, ni supplément');
    expect(text).toContain('Seules les conditions communiquées pour votre départ');
    expect(text).not.toMatch(/\b\d+(?:[.,]\d+)?\s*(?:kg|kilos?|€|EUR|XOF|bagages?)\b/i);
  });

  test('FAQPage mirrors the five visible FAQ questions and answers', async ({ page }) => {
    await page.goto(appUrl(web, '/faq'));
    const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    const faq = scripts
      .map((value) => JSON.parse(value) as { '@type'?: string; mainEntity?: unknown[] })
      .find((value) => value['@type'] === 'FAQPage');
    expect(faq).toBeDefined();

    const entities = faq!.mainEntity as Array<{
      name: string;
      acceptedAnswer: { text: string };
    }>;
    expect(entities).toHaveLength(5);
    for (const entity of entities) {
      await expect(page.locator('main')).toContainText(entity.name);
      await expect(page.locator('main')).toContainText(entity.acceptedAnswer.text);
    }
  });
});
