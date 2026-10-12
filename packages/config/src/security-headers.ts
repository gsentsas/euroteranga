/**
 * Baseline HTTP security headers for the Next.js frontends.
 *
 * A Content-Security-Policy is deliberately not set yet: a real policy needs
 * the final list of script, style and API origins and is planned for the
 * security hardening phase. HSTS is left to the TLS-terminating proxy, which
 * must only enable it once every subdomain serves valid HTTPS.
 */
export const foundationSecurityHeaders: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];
