import { loadPublicEnv } from '@euroteranga/config';

// Each variable is referenced explicitly so Next.js inlines it at build time.
export const publicEnv = loadPublicEnv({
  NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_CLIENT_URL: process.env.NEXT_PUBLIC_CLIENT_URL,
});

if (!publicEnv.NEXT_PUBLIC_CLIENT_URL) {
  throw new Error('NEXT_PUBLIC_CLIENT_URL is required by the booking app (customer account links)');
}

/** Customer account app: sign-up and "Mes réservations". */
export const clientAppUrl = publicEnv.NEXT_PUBLIC_CLIENT_URL.replace(/\/+$/, '');

/**
 * The only payment provider of this release, SANDBOX, runs in local and ci
 * only (refused in staging and production): payments there are simulated.
 */
export const paymentTestEnvironment =
  publicEnv.NEXT_PUBLIC_APP_ENV === 'local' || publicEnv.NEXT_PUBLIC_APP_ENV === 'ci';
