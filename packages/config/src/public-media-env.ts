import { z } from 'zod';
import { localRootProblems, pathsOverlap } from './schemas.js';

export const PUBLIC_MEDIA_MAX_BYTES_BOUNDS = {
  min: 1_024,
  max: 20 * 1_024 * 1_024,
  default: 10 * 1_024 * 1_024,
} as const;

export const PUBLIC_MEDIA_MAX_PIXELS_BOUNDS = {
  min: 1_000_000,
  max: 100_000_000,
  default: 40_000_000,
} as const;

export const PUBLIC_MEDIA_STORAGES = ['DISABLED', 'LOCAL'] as const;

/**
 * MEDIA-1 public media library of the website. Disabled by default.
 *
 * LOCAL stores re-encoded, metadata-free renditions of public images in a
 * dedicated directory served through the API (never by the web server).
 * Unlike passenger documents it is allowed in staging and production: the
 * files are public by nature and hold no personal data. Its root must never
 * be, contain or sit inside the private passenger-document root.
 */
export const publicMediaEnvShape = {
  PUBLIC_MEDIA_STORAGE: z.enum(PUBLIC_MEDIA_STORAGES).default('DISABLED'),
  /** Absolute dedicated directory; only read when PUBLIC_MEDIA_STORAGE=LOCAL. */
  PUBLIC_MEDIA_LOCAL_ROOT: z.string().min(1).max(1024).optional(),
  PUBLIC_MEDIA_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(PUBLIC_MEDIA_MAX_BYTES_BOUNDS.min)
    .max(PUBLIC_MEDIA_MAX_BYTES_BOUNDS.max)
    .default(PUBLIC_MEDIA_MAX_BYTES_BOUNDS.default),
  /** Decoding limit (width × height) against decompression bombs. */
  PUBLIC_MEDIA_MAX_PIXELS: z.coerce
    .number()
    .int()
    .min(PUBLIC_MEDIA_MAX_PIXELS_BOUNDS.min)
    .max(PUBLIC_MEDIA_MAX_PIXELS_BOUNDS.max)
    .default(PUBLIC_MEDIA_MAX_PIXELS_BOUNDS.default),
};

type PublicMediaEnvInput = z.infer<z.ZodObject<typeof publicMediaEnvShape>> & {
  OBJECT_STORAGE_LOCAL_ROOT?: string | undefined;
};

export function refinePublicMediaEnv(env: PublicMediaEnvInput, ctx: z.RefinementCtx): void {
  if (env.PUBLIC_MEDIA_STORAGE !== 'LOCAL') return;
  const issue = (message: string) =>
    ctx.addIssue({ code: 'custom', path: ['PUBLIC_MEDIA_LOCAL_ROOT'], message });
  const root = env.PUBLIC_MEDIA_LOCAL_ROOT;
  if (!root) {
    issue('is required when PUBLIC_MEDIA_STORAGE=LOCAL');
    return;
  }
  for (const problem of localRootProblems(root)) issue(problem);
  if (env.OBJECT_STORAGE_LOCAL_ROOT && pathsOverlap(root, env.OBJECT_STORAGE_LOCAL_ROOT)) {
    issue('must be separate from OBJECT_STORAGE_LOCAL_ROOT (private passenger documents)');
  }
}
