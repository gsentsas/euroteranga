import path from 'node:path';
import { createFoundationNextConfig } from '@euroteranga/config';
import { DEFAULT_SITE_SETTINGS } from '@euroteranga/content';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// Load the repository-level .env shared by all apps (no-op when absent, e.g. in
// CI) before the public environment is validated.
loadEnvConfig(path.resolve(process.cwd(), '../..'));

// UI-PUBLIC-1: the trip search form is sent to the booking application, the
// only origin besides the site itself that a form may target (CSP form-action).
const nextConfig: NextConfig = createFoundationNextConfig(process.env, {
  formActionOrigins: [process.env.PUBLIC_BOOKING_URL ?? DEFAULT_SITE_SETTINGS.apps.bookingUrl],
});

export default nextConfig;
