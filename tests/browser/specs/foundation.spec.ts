import { expect, test } from '@playwright/test';
import { appUrl, frontendApps } from '../apps.js';

for (const app of frontendApps) {
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
    await expect(page.getByRole('contentinfo')).toContainText('Platform under development');

    // Let hydration and any client effects finish before asserting no errors.
    await page.waitForLoadState('networkidle');
    expect(runtimeErrors).toEqual([]);
  });
}

test('ops: Refine provides the foundation navigation', async ({ page }) => {
  const ops = frontendApps.find((app) => app.name === 'ops');
  if (!ops) throw new Error('ops app is not registered');

  await page.goto(appUrl(ops));
  const navigation = page.getByRole('navigation', { name: 'Navigation principale' });
  await expect(navigation.getByRole('link', { name: 'Foundation' })).toBeVisible();
});

test('web: the skip link is reachable by keyboard and moves focus to main', async ({ page }) => {
  const web = frontendApps.find((app) => app.name === 'web');
  if (!web) throw new Error('web app is not registered');

  await page.goto(appUrl(web));
  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Aller au contenu' });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
});
