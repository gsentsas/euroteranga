import { describe, expect, it } from 'vitest';
import { loadPublicEnv } from './public-env.js';
import { buildFoundationSecurityHeaders, HSTS_VALUE } from './security-headers.js';

const headersFor = (appEnv: string) =>
  buildFoundationSecurityHeaders(
    loadPublicEnv({
      NEXT_PUBLIC_APP_ENV: appEnv,
      NEXT_PUBLIC_API_BASE_URL:
        appEnv === 'staging' || appEnv === 'production'
          ? 'https://api.example.test'
          : 'http://localhost:4000',
    }),
  );
const value = (appEnv: string, key: string) =>
  headersFor(appEnv).find((header) => header.key === key)?.value;

describe('frontend security headers', () => {
  it('sends HSTS from every deployed frontend, never with preload', () => {
    for (const appEnv of ['staging', 'production']) {
      expect(value(appEnv, 'Strict-Transport-Security'), appEnv).toBe(HSTS_VALUE);
    }
    expect(HSTS_VALUE).toBe('max-age=31536000; includeSubDomains');
    expect(HSTS_VALUE).not.toContain('preload');
  });

  it('never sends HSTS over the plain HTTP of local and CI builds', () => {
    for (const appEnv of ['local', 'ci']) {
      expect(value(appEnv, 'Strict-Transport-Security'), appEnv).toBeUndefined();
    }
  });

  it('keeps the CSP and the baseline headers in every environment', () => {
    for (const appEnv of ['local', 'ci', 'staging', 'production']) {
      expect(value(appEnv, 'Content-Security-Policy'), appEnv).toContain("frame-ancestors 'none'");
      expect(value(appEnv, 'X-Content-Type-Options'), appEnv).toBe('nosniff');
      expect(value(appEnv, 'X-Frame-Options'), appEnv).toBe('DENY');
    }
  });
});
