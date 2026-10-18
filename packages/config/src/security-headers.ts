import type { PublicEnv } from './public-env.js';

export interface FoundationSecurityHeader {
  key: string;
  value: string;
}

/**
 * Baseline HTTP security headers shared by every Next.js frontend.
 *
 * PR-24 adds an application CSP that keeps scripts/connects on known origins
 * while retaining the inline bootstrap required by the current Next.js
 * runtime.
 */
export const foundationSecurityHeaders: ReadonlyArray<FoundationSecurityHeader> = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

function contentSecurityPolicy(env: PublicEnv): string {
  const deployed =
    env.NEXT_PUBLIC_APP_ENV === 'staging' || env.NEXT_PUBLIC_APP_ENV === 'production';
  const localDevelopment = env.NEXT_PUBLIC_APP_ENV === 'local';
  const apiOrigin = new URL(env.NEXT_PUBLIC_API_BASE_URL).origin;

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${localDevelopment ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}${localDevelopment ? ' ws: wss:' : ''}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ];
  if (deployed) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/**
 * OPS-DEPLOY-1: every public host is HTTPS-only (valid certificates on the
 * apex and all sub-domains), so each deployed frontend sends HSTS itself,
 * with the same value as the Core API (helmet). Before, only the apex sent
 * it, from the proxy. No `preload`: inclusion in browser preload lists is a
 * separate, hard-to-reverse owner decision. Local and CI builds serve plain
 * HTTP and never send it.
 */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

export function buildFoundationSecurityHeaders(
  env: PublicEnv,
): ReadonlyArray<FoundationSecurityHeader> {
  const deployed =
    env.NEXT_PUBLIC_APP_ENV === 'staging' || env.NEXT_PUBLIC_APP_ENV === 'production';
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(env) },
    ...foundationSecurityHeaders,
    ...(deployed ? [{ key: 'Strict-Transport-Security', value: HSTS_VALUE }] : []),
  ];
}
