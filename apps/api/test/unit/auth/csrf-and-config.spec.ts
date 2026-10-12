import { randomBytes } from 'node:crypto';
import { loadApiEnv } from '@euroteranga/config';
import { describe, expect, it } from 'vitest';
import { buildAuthConfig } from '../../../src/auth/auth.config.js';
import { CsrfService } from '../../../src/auth/csrf/csrf.service.js';

const key = () => randomBytes(32).toString('base64');

function env(overrides: Record<string, string> = {}) {
  return loadApiEnv({
    APP_ENV: 'local',
    DATABASE_URL: 'postgresql://user:placeholder@localhost:5432/db',
    AUTH_CSRF_KEY: key(),
    AUTH_HMAC_KEY: key(),
    AUTH_TOTP_ENCRYPTION_KEY: key(),
    AUTH_MAIL_PROVIDER: 'disabled',
    CLIENT_PUBLIC_URL: 'http://localhost:3002',
    AUTH_CUSTOMER_ORIGINS: 'http://localhost:3002',
    ...overrides,
  });
}

function productionEnv() {
  return env({
    APP_ENV: 'production',
    NODE_ENV: 'production',
    AUTH_MAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    AUTH_EMAIL_FROM: 'no-reply@example.test',
    CLIENT_PUBLIC_URL: 'https://client.example.test',
    AUTH_CUSTOMER_ORIGINS: 'https://client.example.test',
    AUTH_STAFF_ORIGINS: 'https://ops.example.test',
    AUTH_CREW_ORIGINS: 'https://crew.example.test',
  });
}

describe('CSRF tokens', () => {
  const csrf = new CsrfService(buildAuthConfig(env()));
  const sessionId = '0190a0a0-0000-7000-8000-00000000000a';

  it('verifies a token for the session it was issued for', () => {
    const { csrfToken, expiresAt } = csrf.issue(sessionId);
    expect(csrfToken).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(csrf.verify(sessionId, csrfToken)).toBe(true);
  });

  it('rejects another session, expiry, tampering, another key and junk', () => {
    const now = Date.now();
    const { csrfToken } = csrf.issue(sessionId, now);
    expect(csrf.verify('0190a0a0-0000-7000-8000-00000000000b', csrfToken)).toBe(false);
    expect(csrf.verify(sessionId, csrfToken, now + 3 * 3600_000)).toBe(false);

    const [version, expires, nonce, mac] = csrfToken.split('.');
    expect(csrf.verify(sessionId, [version, Number(expires) + 3600, nonce, mac].join('.'))).toBe(
      false,
    );
    expect(csrf.verify(sessionId, [version, expires, 'other-nonce', mac].join('.'))).toBe(false);
    expect(new CsrfService(buildAuthConfig(env())).verify(sessionId, csrfToken)).toBe(false);
    for (const junk of [undefined, '', 'v1', 'v2.1.a.b', `${csrfToken}.extra`, 'x'.repeat(300)]) {
      expect(csrf.verify(sessionId, junk)).toBe(false);
    }
  });
});

describe('auth configuration', () => {
  it('uses plain cookie names and no Secure flag only outside staging/production', () => {
    const local = buildAuthConfig(env());
    expect(local.secureCookies).toBe(false);
    expect(local.realms.customer.sessionCookieName).toBe('et_customer_session');
    expect(local.staffChallengeCookieName).toBe('et_staff_mfa');
  });

  it('derives __Host- secure cookies from APP_ENV=production alone', () => {
    const prod = buildAuthConfig(productionEnv());
    expect(prod.secureCookies).toBe(true);
    expect(prod.realms.customer.sessionCookieName).toBe('__Host-et_customer_session');
    expect(prod.realms.staff.sessionCookieName).toBe('__Host-et_staff_session');
    expect(prod.realms.crew.sessionCookieName).toBe('__Host-et_crew_session');
    expect(prod.staffChallengeCookieName).toBe('__Host-et_staff_mfa');
  });

  it('requires MFA for staff only and keeps realm TTLs separate', () => {
    const config = buildAuthConfig(env());
    expect(config.realms.staff.mfaRequired).toBe(true);
    expect(config.realms.customer.mfaRequired).toBe(false);
    expect(config.realms.crew.mfaRequired).toBe(false);
    expect(config.realms.staff.sessionAbsoluteMs).toBe(12 * 3600_000);
    expect(config.realms.staff.sessionIdleMs).toBe(3600_000);
    expect(config.realms.customer.sessionAbsoluteMs).toBe(30 * 86400_000);
    expect(config.mfaChallengeMaxAttempts).toBe(5);
    expect(config.mfaChallengeTtlMs).toBe(300_000);
    expect(config.passwordResetTtlMs).toBe(1800_000);
  });

  it('builds the CORS allow-list from exact origins only', () => {
    const config = buildAuthConfig(
      env({
        AUTH_STAFF_ORIGINS: 'http://localhost:3004',
        API_CORS_ORIGINS: 'http://localhost:3000',
      }),
    );
    expect(config.corsOrigins).toEqual(
      expect.arrayContaining([
        'http://localhost:3000',
        'http://localhost:3002',
        'http://localhost:3004',
      ]),
    );
    expect(config.corsOrigins).not.toContain('*');
  });
});
