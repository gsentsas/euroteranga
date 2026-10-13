import { loadPublicEnv } from '@euroteranga/config';

// Each variable is referenced explicitly so Next.js inlines it at build time.
export const publicEnv = loadPublicEnv({
  NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
});

/**
 * The only payment provider of this release, SANDBOX, runs in local and ci
 * only (refused in staging and production): payments there are simulated.
 */
export const paymentTestEnvironment =
  publicEnv.NEXT_PUBLIC_APP_ENV === 'local' || publicEnv.NEXT_PUBLIC_APP_ENV === 'ci';
