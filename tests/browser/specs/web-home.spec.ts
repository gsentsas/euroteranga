import { expect, test } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';
import { homeSeed } from '../content-seed.js';
import { bookingSeed } from '../fixtures.js';

const web = appByName('web');
const booking = appByName('booking');

/**
 * UI-PUBLIC-1: the home page layout reads real data. The hero search and
 * the departures use the booking seed's stops; dates, seats and fares come
 * from the public trip search (Pricing), and both open the booking
 * application pre-filled (?from=&to=&date=), which runs the search at once.
 */
test.describe('public homepage (UI-PUBLIC-1)', () => {
  test('lists real departures and opens the booking application pre-filled', async ({ page }) => {
    const { path } = homeSeed();
    const seed = bookingSeed();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    const response = await page.goto(appUrl(web, path));
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Voyagez entre l’Europe et l’Afrique en toute confiance',
    );

    const search = page.getByRole('search', { name: 'Rechercher un voyage' });
    await expect(search.getByLabel('Départ')).toHaveValue(seed.originCode);
    await expect(search.getByLabel('Arrivée')).toHaveValue(seed.destinationCode);
    await expect(search.getByLabel('Voyageurs')).toHaveValue('1');

    // The seeded trip of 15 June 2030, its Pricing fare and a pre-filled link.
    const card = page.locator('.public-departure').filter({ hasText: '15 juin 2030' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('08:00');
    await expect(card).toContainText(/123,45\s€\spar place/);
    const reserve = card.getByRole('link', { name: /^Réserver/ });
    const href = new URL((await reserve.getAttribute('href')) ?? '');
    expect(href.searchParams.get('from')).toBe(seed.originCode);
    expect(href.searchParams.get('to')).toBe(seed.destinationCode);
    expect(href.searchParams.get('date')).toBe('2030-06-15');

    // The hero search sends the same query to the booking application.
    await page.route('https://booking.euroteranga.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }),
    );
    await search.getByLabel('Date aller').fill('2030-06-15');
    await search.getByLabel('Voyageurs').selectOption('2');
    const submitted = page.waitForRequest((request) =>
      request.url().startsWith('https://booking.euroteranga.com/'),
    );
    await search.getByRole('button', { name: /Rechercher/ }).click();
    const query = new URL((await submitted).url()).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      from: seed.originCode,
      to: seed.destinationCode,
      date: '2030-06-15',
      passengers: '2',
    });

    // The booking application pre-fills its search from that query and runs it.
    await page.goto(appUrl(booking, `/?${query.toString()}`));
    await expect(page.getByLabel('Date de départ')).toHaveValue('2030-06-15');
    await expect(page.getByRole('heading', { name: 'Voyages disponibles' })).toBeVisible();
    await expect(page.getByText(seed.tripReference).first()).toBeVisible();
    await page.getByRole('button', { name: `Choisir le voyage ${seed.tripReference}` }).click();
    await expect(page.getByTestId('booking-passengers-hint')).toHaveText(
      'Vous voyagez à 2 : choisissez 2 sièges.',
    );
    expect(errors).toEqual([]);
  });

  test('ignores an invalid pre-filled search instead of failing', async ({ page }) => {
    await page.goto(appUrl(booking, '/?from=../etc&to=%3Cscript%3E&date=2030-02-31&passengers=99'));
    await expect(page.getByTestId('booking-flow')).toBeVisible();
    await expect(page.getByLabel('Date de départ')).toHaveValue('');
    await expect(page.getByRole('heading', { name: 'Voyages disponibles' })).toHaveCount(0);
  });
});
