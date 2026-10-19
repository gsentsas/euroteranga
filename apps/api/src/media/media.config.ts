import type { ApiEnv } from '@euroteranga/config';

export const PUBLIC_MEDIA_CONFIG = Symbol('PUBLIC_MEDIA_CONFIG');
export const PUBLIC_MEDIA_STORAGE = Symbol('PUBLIC_MEDIA_STORAGE');

export interface PublicMediaConfig {
  storage: { provider: 'DISABLED' } | { provider: 'LOCAL'; root: string };
  maxBytes: number;
  maxPixels: number;
}

/** The environment has already passed the cross-field schema refinements. */
export function buildPublicMediaConfig(env: ApiEnv): PublicMediaConfig {
  return {
    storage:
      env.PUBLIC_MEDIA_STORAGE === 'LOCAL'
        ? { provider: 'LOCAL', root: env.PUBLIC_MEDIA_LOCAL_ROOT! }
        : { provider: 'DISABLED' },
    maxBytes: env.PUBLIC_MEDIA_MAX_BYTES,
    maxPixels: env.PUBLIC_MEDIA_MAX_PIXELS,
  };
}
