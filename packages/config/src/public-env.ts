import { z } from 'zod';
import { ConfigValidationError, describeIssues } from './errors.js';
import { appEnvSchema, httpUrlSchema } from './schemas.js';

/**
 * Variables exposed to the browser. Everything prefixed NEXT_PUBLIC_ is inlined
 * into client bundles, so nothing secret may ever live here.
 */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_ENV: appEnvSchema,
  NEXT_PUBLIC_API_BASE_URL: httpUrlSchema,
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

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
