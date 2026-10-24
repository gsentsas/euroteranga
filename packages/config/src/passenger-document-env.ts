import { z } from 'zod';
import { booleanFlag, localRootProblems } from './schemas.js';

export const PASSENGER_DOCUMENT_MAX_BYTES_BOUNDS = {
  min: 1_024,
  max: 25 * 1_024 * 1_024,
  default: 10 * 1_024 * 1_024,
} as const;

export const OBJECT_STORAGE_PROVIDERS = ['DISABLED', 'LOCAL', 'S3'] as const;
export const MALWARE_SCANNERS = ['DISABLED', 'TEST', 'CLAMAV'] as const;

/**
 * Private passenger-document settings. LOCAL is a production-capable private
 * filesystem adapter when paired with CLAMAV and a dedicated persistent root.
 * TEST remains local/CI only. S3 stays available as an optional adapter but is
 * not required by the EURO TERANGA production architecture.
 */
export const passengerDocumentEnvShape = {
  PASSENGER_DOCUMENT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(PASSENGER_DOCUMENT_MAX_BYTES_BOUNDS.min)
    .max(PASSENGER_DOCUMENT_MAX_BYTES_BOUNDS.max)
    .default(PASSENGER_DOCUMENT_MAX_BYTES_BOUNDS.default),

  OBJECT_STORAGE_PROVIDER: z.enum(OBJECT_STORAGE_PROVIDERS).default('DISABLED'),
  /** Absolute, private directory; only read when provider=LOCAL. */
  OBJECT_STORAGE_LOCAL_ROOT: z.string().min(1).max(1024).optional(),
  OBJECT_STORAGE_ENDPOINT: z
    .url()
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
      message: 'must use the http or https protocol',
    })
    .optional(),
  OBJECT_STORAGE_REGION: z.string().trim().min(1).max(64).optional(),
  OBJECT_STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid private bucket name')
    .optional(),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(1).max(256).optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().min(1).max(512).optional(),
  OBJECT_STORAGE_FORCE_PATH_STYLE: booleanFlag.default(true),

  MALWARE_SCANNER: z.enum(MALWARE_SCANNERS).default('DISABLED'),
  CLAMAV_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.-]+$/, 'must be a hostname')
    .optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
};

type PassengerDocumentEnvInput = z.infer<z.ZodObject<typeof passengerDocumentEnvShape>> & {
  APP_ENV: string;
};

/** Cross-field fail-safe rules: no implicit public/local/scan-disabled fallback. */
export function refinePassengerDocumentEnv(
  env: PassengerDocumentEnvInput,
  ctx: z.RefinementCtx,
): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  const deployed = env.APP_ENV === 'staging' || env.APP_ENV === 'production';

  if (env.OBJECT_STORAGE_PROVIDER === 'DISABLED') {
    if (env.MALWARE_SCANNER !== 'DISABLED') {
      issue('MALWARE_SCANNER', 'must be DISABLED when object storage is disabled');
    }
    return;
  }

  if (env.MALWARE_SCANNER === 'DISABLED') {
    issue('MALWARE_SCANNER', 'must fail closed with a scanner when document storage is enabled');
  }

  if (env.OBJECT_STORAGE_PROVIDER === 'LOCAL') {
    const root = env.OBJECT_STORAGE_LOCAL_ROOT;
    if (!root) {
      issue('OBJECT_STORAGE_LOCAL_ROOT', 'is required when OBJECT_STORAGE_PROVIDER=LOCAL');
    } else {
      for (const problem of localRootProblems(root)) issue('OBJECT_STORAGE_LOCAL_ROOT', problem);
    }
    if (
      deployed &&
      root &&
      (root === '/tmp' ||
        root.startsWith('/tmp/') ||
        root === '/var/tmp' ||
        root.startsWith('/var/tmp/'))
    ) {
      issue(
        'OBJECT_STORAGE_LOCAL_ROOT',
        'must use a persistent private directory outside temporary storage in staging and production',
      );
    }
  }

  if (env.OBJECT_STORAGE_PROVIDER === 'S3') {
    for (const name of [
      'OBJECT_STORAGE_ENDPOINT',
      'OBJECT_STORAGE_REGION',
      'OBJECT_STORAGE_BUCKET',
      'OBJECT_STORAGE_ACCESS_KEY',
      'OBJECT_STORAGE_SECRET_KEY',
    ] as const) {
      if (!env[name]) issue(name, `is required when OBJECT_STORAGE_PROVIDER=S3`);
    }
    if (deployed && env.OBJECT_STORAGE_ENDPOINT?.startsWith('http://')) {
      issue('OBJECT_STORAGE_ENDPOINT', 'must use https in staging and production');
    }
  }

  if (env.MALWARE_SCANNER === 'TEST' && deployed) {
    issue('MALWARE_SCANNER', 'TEST is refused in staging and production');
  }
  if (env.MALWARE_SCANNER === 'CLAMAV' && !env.CLAMAV_HOST) {
    issue('CLAMAV_HOST', 'is required when MALWARE_SCANNER=CLAMAV');
  }
}
