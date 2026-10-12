import { z } from 'zod';
import { ConfigValidationError, describeIssues } from './errors.js';
import { appEnvSchema, booleanFlag, originListSchema } from './schemas.js';

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: appEnvSchema,
  DATABASE_URL: z
    .string({ error: 'is required' })
    .min(1, 'is required')
    .refine((value) => /^postgres(ql)?:\/\/.+/.test(value), {
      message: 'must be a postgresql:// connection string',
    }),
  // Loopback by default: the API is meant to sit behind a reverse proxy.
  // Containers set 0.0.0.0 explicitly.
  API_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.:-]+$/, 'must be a hostname or IP address')
    .default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_CORS_ORIGINS: originListSchema.default([]),
  OPENAPI_ENABLED: booleanFlag.default(false),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/**
 * Validates the API environment once, at startup. Throws a
 * ConfigValidationError naming every invalid variable so a misconfigured
 * process fails immediately instead of crashing later on first use.
 */
export function loadApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const result = apiEnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError('API', describeIssues(result.error));
  }
  return result.data;
}
