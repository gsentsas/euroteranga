import { loadJourneyPublicUrls, loadPublicEnv } from '@euroteranga/config';

// Each variable is referenced explicitly so Next.js inlines it at build time.
export const publicEnv = loadPublicEnv({
  NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_BOOKING_URL: process.env.NEXT_PUBLIC_BOOKING_URL,
  NEXT_PUBLIC_CLIENT_URL: process.env.NEXT_PUBLIC_CLIENT_URL,
  NEXT_PUBLIC_TRACKING_URL: process.env.NEXT_PUBLIC_TRACKING_URL,
});

export const journeyLinks = loadJourneyPublicUrls(publicEnv);
