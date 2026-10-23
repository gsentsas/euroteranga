import { z } from 'zod';
import { ConfigValidationError, describeIssues } from './errors.js';
import { appEnvSchema, httpUrlSchema } from './schemas.js';

/**
 * Variables exposed to the browser. Everything prefixed NEXT_PUBLIC_ is inlined
 * into client bundles, so nothing secret may ever live here.
 */
export const publicEnvSchema = z
  .object({
    NEXT_PUBLIC_APP_ENV: appEnvSchema,
    NEXT_PUBLIC_API_BASE_URL: httpUrlSchema,
    /** Public application URLs used by the shared traveller navigation. */
    NEXT_PUBLIC_SITE_URL: httpUrlSchema.optional(),
    NEXT_PUBLIC_BOOKING_URL: httpUrlSchema.optional(),
    NEXT_PUBLIC_CLIENT_URL: httpUrlSchema.optional(),
    NEXT_PUBLIC_TRACKING_URL: httpUrlSchema.optional(),
  })
  .superRefine((env, ctx) => {
    const deployed =
      env.NEXT_PUBLIC_APP_ENV === 'staging' || env.NEXT_PUBLIC_APP_ENV === 'production';
    if (!deployed) return;

    const requireHttps = (
      name:
        | 'NEXT_PUBLIC_API_BASE_URL'
        | 'NEXT_PUBLIC_SITE_URL'
        | 'NEXT_PUBLIC_BOOKING_URL'
        | 'NEXT_PUBLIC_CLIENT_URL'
        | 'NEXT_PUBLIC_TRACKING_URL',
      value?: string,
    ) => {
      if (value && !value.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'must use https in staging and production',
        });
      }
    };
    requireHttps('NEXT_PUBLIC_API_BASE_URL', env.NEXT_PUBLIC_API_BASE_URL);
    requireHttps('NEXT_PUBLIC_SITE_URL', env.NEXT_PUBLIC_SITE_URL);
    requireHttps('NEXT_PUBLIC_BOOKING_URL', env.NEXT_PUBLIC_BOOKING_URL);
    requireHttps('NEXT_PUBLIC_CLIENT_URL', env.NEXT_PUBLIC_CLIENT_URL);
    requireHttps('NEXT_PUBLIC_TRACKING_URL', env.NEXT_PUBLIC_TRACKING_URL);
  });

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export interface JourneyPublicUrls {
  home: string;
  booking: string;
  client: string;
  tracking: string;
}

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, '');

export function loadJourneyPublicUrls(env: PublicEnv): JourneyPublicUrls {
  const required = [
    ['NEXT_PUBLIC_SITE_URL', env.NEXT_PUBLIC_SITE_URL],
    ['NEXT_PUBLIC_BOOKING_URL', env.NEXT_PUBLIC_BOOKING_URL],
    ['NEXT_PUBLIC_CLIENT_URL', env.NEXT_PUBLIC_CLIENT_URL],
    ['NEXT_PUBLIC_TRACKING_URL', env.NEXT_PUBLIC_TRACKING_URL],
  ] as const;
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new ConfigValidationError(
      'traveller public URLs',
      missing.map((name) => `${name}: required by JourneyShell`),
    );
  }

  return {
    home: `${trimTrailingSlashes(env.NEXT_PUBLIC_SITE_URL!)}/`,
    booking: `${trimTrailingSlashes(env.NEXT_PUBLIC_BOOKING_URL!)}/`,
    client: `${trimTrailingSlashes(env.NEXT_PUBLIC_CLIENT_URL!)}/compte`,
    tracking: `${trimTrailingSlashes(env.NEXT_PUBLIC_TRACKING_URL!)}/`,
  };
}

export function loadPublicEnv(env: Record<string, string | undefined>): PublicEnv {
  const result = publicEnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError('public (NEXT_PUBLIC_*)', describeIssues(result.error));
  }
  return result.data;
}

const SENSITIVE_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|API_?KEY|DATABASE|DSN|CREDENTIAL/i;

/**
 * Fails the build when a variable whose name looks sensitive is prefixed
 * NEXT_PUBLIC_, which would publish its value in client-side JavaScript.
 */
export function assertNoSensitivePublicEnv(env: Record<string, string | undefined>): void {
  const offenders = Object.keys(env).filter(
    (name) => name.startsWith('NEXT_PUBLIC_') && SENSITIVE_NAME.test(name),
  );
  if (offenders.length > 0) {
    throw new ConfigValidationError(
      'public (NEXT_PUBLIC_*)',
      offenders.map((name) => `${name}: sensitive-looking variables must not be NEXT_PUBLIC_`),
    );
  }
}
