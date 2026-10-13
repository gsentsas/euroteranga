import { z } from 'zod';
import { booleanFlag, httpUrlSchema, originListSchema } from './schemas.js';

/**
 * Example secrets published in `.env.example`. They are valid so that local
 * development works out of the box, and therefore refused in staging and
 * production.
 */
export const EXAMPLE_AUTH_SECRETS: readonly string[] = [
  'ZGV2LW9ubHktY3NyZi1rZXktbm90LWEtcmVhbC1zZWNyZXQ=',
  'ZGV2LW9ubHktaG1hYy1rZXktbm90LWEtcmVhbC1zZWNyZXQ=',
  'ZGV2LW9ubHktdG90cC1rZXktbm90LWEtc2VjcmV0ISE=',
];

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$|^[A-Za-z0-9_-]+$/;

/** Decodes a validated base64 / base64url secret into raw key bytes. */
export function decodeSecretKey(value: string): Buffer {
  return Buffer.from(value, /[-_]/.test(value) ? 'base64url' : 'base64');
}

/**
 * A secret encoded in base64 (or base64url). Validation checks the encoding
 * and the decoded length; messages never include the value.
 */
export function secretKey(options: { minBytes: number; exactBytes?: number }) {
  return z
    .string({ error: 'is required' })
    .min(1, 'is required')
    .refine((value) => BASE64.test(value), { message: 'must be base64 encoded' })
    .refine(
      (value) => {
        const length = decodeSecretKey(value).length;
        return options.exactBytes ? length === options.exactBytes : length >= options.minBytes;
      },
      {
        message: options.exactBytes
          ? `must decode to exactly ${options.exactBytes} bytes`
          : `must decode to at least ${options.minBytes} bytes`,
      },
    );
}

const seconds = (defaultValue: number) =>
  z.coerce
    .number()
    .int()
    .min(60)
    .max(400 * 24 * 3600)
    .default(defaultValue);

const DAY = 24 * 3600;

/** Authentication variables, merged into the API environment schema. */
export const authEnvShape = {
  AUTH_CSRF_KEY: secretKey({ minBytes: 32 }),
  AUTH_HMAC_KEY: secretKey({ minBytes: 32 }),
  AUTH_TOTP_ENCRYPTION_KEY: secretKey({ minBytes: 32, exactBytes: 32 }),
  AUTH_TOTP_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  AUTH_CUSTOMER_ORIGINS: originListSchema.default([]),
  AUTH_STAFF_ORIGINS: originListSchema.default([]),
  AUTH_CREW_ORIGINS: originListSchema.default([]),

  AUTH_CUSTOMER_SESSION_ABSOLUTE_SECONDS: seconds(30 * DAY),
  AUTH_CUSTOMER_SESSION_IDLE_SECONDS: seconds(7 * DAY),
  AUTH_STAFF_SESSION_ABSOLUTE_SECONDS: seconds(12 * 3600),
  AUTH_STAFF_SESSION_IDLE_SECONDS: seconds(3600),
  AUTH_CREW_SESSION_ABSOLUTE_SECONDS: seconds(7 * DAY),
  AUTH_CREW_SESSION_IDLE_SECONDS: seconds(DAY),

  AUTH_EMAIL_VERIFICATION_TTL_SECONDS: seconds(DAY),
  AUTH_PASSWORD_RESET_TTL_SECONDS: seconds(30 * 60),
  AUTH_MFA_CHALLENGE_TTL_SECONDS: seconds(5 * 60),
  AUTH_STAFF_INVITATION_TTL_SECONDS: seconds(3 * DAY),
  AUTH_STAFF_ENROLLMENT_GRANT_TTL_SECONDS: seconds(DAY),

  // "disabled" drops auth mail (local/CI without a mail catcher); it is
  // refused in staging and production.
  AUTH_MAIL_PROVIDER: z
    .enum(['smtp', 'disabled'], { error: 'must be smtp or disabled' })
    .default('smtp'),
  AUTH_EMAIL_FROM: z.email({ error: 'must be an email address' }).optional(),
  CLIENT_PUBLIC_URL: httpUrlSchema,
  /** Public URL of the operations back-office (staff invitation links). */
  OPS_PUBLIC_URL: httpUrlSchema,
  SMTP_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.-]+$/, 'must be a hostname')
    .optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanFlag.default(false),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
};

type AuthEnvInput = z.infer<z.ZodObject<typeof authEnvShape>> & {
  APP_ENV: string;
  NODE_ENV: string;
  API_CORS_ORIGINS: string[];
};

const REALMS = ['CUSTOMER', 'STAFF', 'CREW'] as const;
const SECRET_NAMES = ['AUTH_CSRF_KEY', 'AUTH_HMAC_KEY', 'AUTH_TOTP_ENCRYPTION_KEY'] as const;

/** Cross-field rules, stricter in staging and production. */
export function refineAuthEnv(env: AuthEnvInput, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });

  for (const realm of REALMS) {
    if (env[`AUTH_${realm}_SESSION_IDLE_SECONDS`] > env[`AUTH_${realm}_SESSION_ABSOLUTE_SECONDS`]) {
      issue(`AUTH_${realm}_SESSION_IDLE_SECONDS`, 'must not exceed the absolute session lifetime');
    }
  }

  // One key per purpose: reusing a key across purposes weakens all of them.
  const secrets = SECRET_NAMES.map((name) => env[name]);
  if (new Set(secrets).size !== secrets.length) {
    issue('AUTH_CSRF_KEY', 'AUTH_CSRF_KEY, AUTH_HMAC_KEY and AUTH_TOTP_ENCRYPTION_KEY must differ');
  }

  if (env.AUTH_MAIL_PROVIDER === 'smtp') {
    if (!env.SMTP_HOST) issue('SMTP_HOST', 'is required when AUTH_MAIL_PROVIDER=smtp');
    if (!env.AUTH_EMAIL_FROM) issue('AUTH_EMAIL_FROM', 'is required when AUTH_MAIL_PROVIDER=smtp');
  }
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
    issue('SMTP_USER', 'SMTP_USER and SMTP_PASSWORD must be set together');
  }

  const deployed = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
  if (!deployed) return;

  if (env.NODE_ENV !== 'production')
    issue('NODE_ENV', `must be production when APP_ENV=${env.APP_ENV}`);
  for (const name of SECRET_NAMES) {
    if (EXAMPLE_AUTH_SECRETS.includes(env[name])) {
      issue(name, 'must not reuse the example value from .env.example');
    }
  }
  if (env.AUTH_MAIL_PROVIDER !== 'smtp')
    issue('AUTH_MAIL_PROVIDER', 'must be smtp in staging and production');
  if (!env.CLIENT_PUBLIC_URL.startsWith('https://')) issue('CLIENT_PUBLIC_URL', 'must use https');
  if (!env.OPS_PUBLIC_URL.startsWith('https://')) issue('OPS_PUBLIC_URL', 'must use https');
  for (const realm of REALMS) {
    const origins = env[`AUTH_${realm}_ORIGINS`];
    if (origins.length === 0) issue(`AUTH_${realm}_ORIGINS`, 'must list at least one origin');
    if (origins.some((origin) => !origin.startsWith('https://'))) {
      issue(`AUTH_${realm}_ORIGINS`, 'must only contain https origins');
    }
  }
  if (env.API_CORS_ORIGINS.some((origin) => !origin.startsWith('https://'))) {
    issue('API_CORS_ORIGINS', 'must only contain https origins');
  }
}
