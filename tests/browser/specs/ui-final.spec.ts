import { expect, test } from '@playwright/test';
import { appUrl, frontendApps } from '../apps.js';

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 400, height: 844 },
] as const;

for (const app of frontendApps) {
  for (const viewport of viewports) {
    test(`UX-1A: ${app.name} ${viewport.name} keeps the entry surface structurally sound`, async ({
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

      if (app.name === 'web') {
        await page.emulateMedia({ reducedMotion: 'reduce' });
      }

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
          mainCount: document.querySelectorAll('main').length,
          h1Count: document.querySelectorAll('h1').length,
          horizontalOverflow: Math.max(0, documentWidth - window.innerWidth),
        };
      });

      expect(structure.duplicateIds).toEqual([]);
      expect(structure.missingImageAlt).toEqual([]);
      expect(structure.mainCount).toBe(1);
      expect(structure.h1Count).toBe(1);
      expect(structure.horizontalOverflow).toBeLessThanOrEqual(1);

      if (viewport.name === 'mobile') {
        const tapTargetSelector =
          app.name === 'crew'
            ? '.crew-topbar__nav a'
            : ['booking', 'client', 'tracking'].includes(app.name)
              ? '.et-journey-nav a'
              : null;

        if (tapTargetSelector) {
          const tapTargetHeights = await page.locator(tapTargetSelector).evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().height),
          );
          expect(tapTargetHeights.length).toBeGreaterThan(0);
          for (const height of tapTargetHeights) {
            expect(height).toBeGreaterThanOrEqual(44);
          }
        }
      }

      if (app.name === 'ops') {
        await expect(page.locator('.et-status')).toHaveText(
          'Plateforme en cours de développement',
        );
      }

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

      if (app.name === 'web') {
        const motion = await page.evaluate(() => {
          const button = document.querySelector<HTMLElement>('.public-button');
          return {
            reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
            buttonTransitionDuration: button ? getComputedStyle(button).transitionDuration : null,
          };
        });
        expect(motion).toEqual({
          reducedMotion: true,
          scrollBehavior: 'auto',
          buttonTransitionDuration: '0s',
        });
      }

      expect(runtimeErrors).toEqual([]);
    });
  }
}
