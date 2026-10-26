import { expect, test } from '@playwright/test';
import { appByName, appUrl, frontendApps } from '../apps.js';

// OPS is intentionally auth-protected in PR-02; its unauthenticated redirect and
// authenticated runtime are covered in auth.spec.ts.
for (const app of frontendApps.filter((candidate) => candidate.name !== 'ops')) {
  test(`${app.name}: foundation page renders without runtime errors`, async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
    });

    const response = await page.goto(appUrl(app));

    expect(response?.status()).toBe(200);
    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
    expect(response?.headers()['x-powered-by']).toBeUndefined();
    await expect(page).toHaveTitle(app.title);
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(app.heading);
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    // The public website footer comes from the CMS site settings (WEB-1).
    const footerText =
      app.name === 'crew'
        ? 'Mode terrain'
        : app.name === 'web'
          ? '© '
          : ['booking', 'client', 'tracking'].includes(app.name)
            ? 'Plateforme pilote'
            : 'Platform under development';
    await expect(page.getByRole('contentinfo')).toContainText(footerText);

    // Let hydration and any client effects finish before asserting no errors.
    await page.waitForLoadState('networkidle');
    expect(runtimeErrors).toEqual([]);
  });
}

test('web: the skip link is reachable by keyboard and moves focus to main', async ({ page }) => {
  await page.goto(appUrl(appByName('web')));
  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Aller au contenu' });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
});

test('web: public homepage exposes passenger, parcel, freight, account and tracking journeys', async ({
  page,
}) => {
  await page.goto(appUrl(appByName('web')));

  await expect(page.getByRole('link', { name: /Rechercher un voyage/i }).first()).toHaveAttribute(
    'href',
    'https://booking.euroteranga.com/',
  );
  await expect(page.getByRole('banner').getByRole('link', { name: 'Mon compte' })).toHaveAttribute(
    'href',
    'https://client.euroteranga.com/',
  );
  await expect(page.getByRole('link', { name: /Ouvrir le suivi/i }).first()).toHaveAttribute(
    'href',
    'https://tracking.euroteranga.com/',
  );
  // PUBLIC-HOME-1: the three services right after the hero, each with a real destination.
  const services = page.locator('#services');
  await expect(
    services.getByRole('heading', { name: 'Voyageurs, colis ou fret : choisissez votre service' }),
  ).toBeVisible();
  await expect(services.getByRole('link', { name: /Voir les prochains départs/ })).toHaveAttribute(
    'href',
    '#trajets',
  );
  await expect(services.getByRole('link', { name: /Envoyer un colis/ })).toHaveAttribute(
    'href',
    'https://client.euroteranga.com/',
  );
  await expect(services.getByRole('link', { name: /Demander un devis/ })).toHaveAttribute(
    'href',
    'https://client.euroteranga.com/',
  );
  await expect(
    page.locator('#expeditions').getByRole('heading', {
      name: 'Vous n’avez pas besoin de voyager pour emprunter la route EURO TERANGA',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Trois services, des étapes claires.' }),
  ).toBeVisible();
  // Departures and prices come from Booking and Pricing only: without a bookable
  // Paris ↔ Dakar trip, the section says so and no price is shown.
  await expect(
    page.getByText(
      'Les prochains départs seront affichés ici dès leur ouverture à la réservation.',
    ),
  ).toBeVisible();
  await expect(page.locator('main')).not.toContainText('€');
});
