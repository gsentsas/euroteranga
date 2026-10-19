import type { PublicEnv } from './public-env.js';

export interface FoundationSecurityHeader {
  key: string;
  value: string;
}

/**
 * Baseline HTTP security headers shared by every Next.js frontend.
 *
 * HSTS remains the responsibility of the TLS-terminating reverse proxy: it
 * must only be enabled once every public subdomain is HTTPS-only. PR-24 adds
 * an application CSP that keeps scripts/connects on known origins while
 * retaining the inline bootstrap required by the current Next.js runtime.
 */
export const foundationSecurityHeaders: ReadonlyArray<FoundationSecurityHeader> = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

export interface FoundationSecurityOptions {
  /**
   * Exact origins a form of this frontend may be sent to, besides itself
   * (UI-PUBLIC-1: the website's trip search opens the booking application).
   */
  formActionOrigins?: readonly string[];
}

/** The exact origin of an absolute URL; https only in staging and production. */
function formOrigin(url: string, deployed: boolean): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && (deployed || parsed.protocol !== 'http:')) {
    throw new Error(`form-action origin must use https: ${url}`);
  }
  return parsed.origin;
}

function contentSecurityPolicy(env: PublicEnv, options: FoundationSecurityOptions): string {
  const deployed =
    env.NEXT_PUBLIC_APP_ENV === 'staging' || env.NEXT_PUBLIC_APP_ENV === 'production';
  const localDevelopment = env.NEXT_PUBLIC_APP_ENV === 'local';
  const apiOrigin = new URL(env.NEXT_PUBLIC_API_BASE_URL).origin;
  const formOrigins = [
    ...new Set((options.formActionOrigins ?? []).map((url) => formOrigin(url, deployed))),
  ];

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${localDevelopment ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // MEDIA-1: website images are served by the API (first party only).
    `img-src 'self' data: blob: ${apiOrigin}`,
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}${localDevelopment ? ' ws: wss:' : ''}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self'${formOrigins.map((origin) => ` ${origin}`).join('')}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ];
  if (deployed) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export function buildFoundationSecurityHeaders(
  env: PublicEnv,
  options: FoundationSecurityOptions = {},
): ReadonlyArray<FoundationSecurityHeader> {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(env, options) },
    ...foundationSecurityHeaders,
  ];
}
