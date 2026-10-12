import { defineConfig, devices } from '@playwright/test';
import { appUrl, frontendApps } from './apps.js';

const isCI = Boolean(process.env.CI);

/**
 * Runs the production builds (`next start`) of the six frontends. The apps
 * must be built beforehand (`pnpm build:packages && pnpm build:frontends`).
 * No retries: a flaky failure is a failure.
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: frontendApps.map((app) => ({
    command: `pnpm --filter @euroteranga/${app.name} start`,
    url: appUrl(app),
    reuseExistingServer: !isCI,
    timeout: 60_000,
  })),
});
