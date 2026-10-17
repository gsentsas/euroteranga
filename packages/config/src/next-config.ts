import { assertNoSensitivePublicEnv, loadPublicEnv } from './public-env.js';
import { buildFoundationSecurityHeaders } from './security-headers.js';

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/** Subset of Next.js config set by the foundation (structurally typed). */
export interface FoundationNextConfig {
  reactStrictMode: boolean;
  poweredByHeader: boolean;
  headers: () => Promise<HeaderRule[]>;
}

/**
 * Shared Next.js configuration for every frontend. Validates the public
 * environment when next.config is loaded, so `next dev` and `next build` stop
 * immediately on a missing or sensitive NEXT_PUBLIC_ variable.
 */
export function createFoundationNextConfig(
  env: Record<string, string | undefined> = process.env,
): FoundationNextConfig {
  assertNoSensitivePublicEnv(env);
  const publicEnv = loadPublicEnv(env);

  return {
    reactStrictMode: true,
    poweredByHeader: false,
    headers: async () => [
      { source: '/:path*', headers: [...buildFoundationSecurityHeaders(publicEnv)] },
    ],
  };
}
