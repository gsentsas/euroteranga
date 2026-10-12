import { z } from 'zod';

export const appEnvSchema = z.enum(['local', 'ci', 'staging', 'production'], {
  error: 'must be one of: local, ci, staging, production',
});

export const httpUrlSchema = z
  .string({ error: 'is required' })
  .refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), {
    message: 'must be an http(s) URL',
  });

/** Accepts "true"/"false" (and 1/0) from the environment. */
export const booleanFlag = z
  .enum(['true', 'false', '1', '0'], { error: 'must be true or false' })
  .transform((value) => value === 'true' || value === '1');

/**
 * Comma-separated list of exact origins. A wildcard is rejected on purpose:
 * future authenticated endpoints must never be reachable from any origin.
 */
export const originListSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(
    z.array(
      z.string().refine(
        (origin) => {
          if (origin === '*' || !URL.canParse(origin)) return false;
          const url = new URL(origin);
          return /^https?:$/.test(url.protocol) && url.origin === origin;
        },
        { message: 'each entry must be an exact http(s) origin without path; "*" is not allowed' },
      ),
    ),
  );
