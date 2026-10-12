import { defineConfig, devices } from '@playwright/test';
import { API_URL, appUrl, frontendApps } from './apps.js';

const isCI = Boolean(process.env.CI);

/**
 * Runs the production builds of the six frontends (`next start`) and of the
 * Core API (`node dist/main.js`) against a disposable PostgreSQL database.
 * Build first: `pnpm build`. The API reads its configuration from the
 * environment (see .github/workflows/ci.yml, job "browser").
 * No retries: a flaky failure is a failure.
 */
export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @euroteranga/api start',
      url: `${API_URL}/health/ready`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    ...frontendApps.map((app) => ({
      command: `pnpm --filter @euroteranga/${app.name} start`,
      url: appUrl(app, '/'),
      reuseExistingServer: !isCI,
      timeout: 60_000,
    })),
  ],
});
