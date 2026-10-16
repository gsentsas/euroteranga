import { expect, test } from '@playwright/test';
import { appByName, appUrl } from '../apps.js';

const tracking = appByName('tracking');

test('tracking: public approximate projection never exposes precise GPS data', async ({ page }) => {
  const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  await page.route(`**/v1/tracking/${token}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tripReference: 'ET-TRACK-0001',
        tripStatus: 'IN_PROGRESS',
        route: { code: 'PAR-DKR', name: 'Paris → Dakar' },
        plannedDepartureAt: '2026-10-16T08:00:00.000Z',
        plannedArrivalAt: '2026-10-18T18:00:00.000Z',
        visibility: 'APPROXIMATE',
        providerStatus: 'UP',
        lastUpdatedAt: '2026-10-16T12:30:00.000Z',
        checkpoint: {
          sequence: 2,
          kind: 'CHECKPOINT',
          code: 'BORDER-01',
          name: 'Frontière',
          type: 'BORDER',
          observedAt: '2026-10-16T12:20:00.000Z',
        },
        position: {
          observedAt: '2026-10-16T12:30:00.000Z',
          latitude: 48.9,
          longitude: 2.4,
          precision: 'APPROXIMATE',
        },
      }),
    });
  });

  const response = await page.goto(appUrl(tracking, `/${token}`));
  expect(response?.status()).toBe(200);

  await expect(page.getByTestId('public-tracking')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ET-TRACK-0001' })).toBeVisible();
  await expect(page.getByTestId('public-tracking-provider-status')).toHaveText('Données récentes');
  await expect(page.getByTestId('public-tracking-checkpoint')).toContainText('BORDER-01');
  await expect(page.getByTestId('public-tracking-position')).toContainText('Zone approximative');
  await expect(page.getByTestId('public-tracking-position')).toContainText('48.9, 2.4');

  const body = await page.locator('body').innerText();
  expect(body).not.toContain('48.856613');
  expect(body).not.toContain('2.352222');
  expect(body).not.toContain('Précision annoncée');
});

test('tracking: invalid, expired or revoked capability renders no tracking data', async ({
  page,
}) => {
  const token = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  await page.route(`**/v1/tracking/${token}`, async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'TRACKING_NOT_FOUND',
        message: 'Suivi indisponible ou lien invalide.',
      }),
    });
  });

  const response = await page.goto(appUrl(tracking, `/${token}`));
  expect(response?.status()).toBe(200);

  await expect(page.getByTestId('tracking-unavailable')).toBeVisible();
  await expect(page.getByTestId('public-tracking')).toHaveCount(0);
});
