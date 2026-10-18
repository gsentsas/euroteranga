import { expect, test } from '@playwright/test';
import { appUrl, frontendApps } from '../apps.js';

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

for (const app of frontendApps) {
  for (const viewport of viewports) {
    test(`UI-4G: ${app.name} ${viewport.name} keeps the entry surface structurally sound`, async ({
      page,
    }) => {
      const runtimeErrors: string[] = [];
      page.on('pageerror', (error) => runtimeErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        // OPS probes the current STAFF session on its public login page.
        // A 401 here is the expected anonymous state, not a runtime failure.
        if (app.name === 'ops' && text.includes('401 (Unauthorized)')) return;
        runtimeErrors.push(text);
      });

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const response = await page.goto(appUrl(app));

      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(app.heading);
      await page.waitForLoadState('networkidle');

      const structure = await page.evaluate(() => {
        const ids = Array.from(document.querySelectorAll<HTMLElement>('[id]'))
          .map((element) => element.id)
          .filter(Boolean);
        const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];

        const missingImageAlt = Array.from(
          document.querySelectorAll<HTMLImageElement>('img:not([alt])'),
        ).map((image) => image.currentSrc || image.src || '<inline image>');

        const documentWidth = Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0,
        );

        return {
          duplicateIds,
          missingImageAlt,
          horizontalOverflow: Math.max(0, documentWidth - window.innerWidth),
        };
      });

      expect(structure.duplicateIds).toEqual([]);
      expect(structure.missingImageAlt).toEqual([]);
      expect(structure.horizontalOverflow).toBeLessThanOrEqual(1);

      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const active = document.activeElement;
        return active && active !== document.body
          ? {
              tag: active.tagName,
              text: (active.textContent ?? '').trim().slice(0, 80),
            }
          : null;
      });
      expect(focused).not.toBeNull();

      expect(runtimeErrors).toEqual([]);
    });
  }
}
