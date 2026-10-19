import { assertNoSensitivePublicEnv, loadPublicEnv } from './public-env.js';
import {
  buildFoundationSecurityHeaders,
  type FoundationSecurityOptions,
} from './security-headers.js';

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
  security: FoundationSecurityOptions = {},
): FoundationNextConfig {
  assertNoSensitivePublicEnv(env);
  const publicEnv = loadPublicEnv(env);
  // Built once: an invalid form-action origin stops `next build` at once.
  const securityHeaders = buildFoundationSecurityHeaders(publicEnv, security);

  return {
    reactStrictMode: true,
    poweredByHeader: false,
    headers: async () => [{ source: '/:path*', headers: [...securityHeaders] }],
  };
}
