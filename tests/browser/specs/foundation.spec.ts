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
    await expect(page.getByRole('contentinfo')).toContainText('Platform under development');

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
