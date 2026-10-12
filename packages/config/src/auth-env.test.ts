import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_AUTH_SECRETS, decodeSecretKey, loadApiEnv } from './index.js';

const key = (bytes = 32) => randomBytes(bytes).toString('base64');

function localEnv(overrides: Record<string, string> = {}) {
  return {
    APP_ENV: 'local',
    DATABASE_URL: 'postgresql://user:placeholder@localhost:5432/euroteranga_test',
    AUTH_CSRF_KEY: key(),
    AUTH_HMAC_KEY: key(),
    AUTH_TOTP_ENCRYPTION_KEY: key(),
    AUTH_MAIL_PROVIDER: 'disabled',
    CLIENT_PUBLIC_URL: 'http://localhost:3002',
    ...overrides,
  };
}

function productionEnv(overrides: Record<string, string> = {}) {
  return localEnv({
    APP_ENV: 'production',
    NODE_ENV: 'production',
    AUTH_MAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    AUTH_EMAIL_FROM: 'no-reply@example.test',
    CLIENT_PUBLIC_URL: 'https://client.example.test',
    AUTH_CUSTOMER_ORIGINS: 'https://client.example.test',
    AUTH_STAFF_ORIGINS: 'https://ops.example.test',
    AUTH_CREW_ORIGINS: 'https://crew.example.test',
    ...overrides,
  });
}

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the configuration to be rejected');
};

describe('authentication configuration', () => {
  it('applies documented session and token defaults', () => {
    expect(loadApiEnv(localEnv())).toMatchObject({
      AUTH_CUSTOMER_SESSION_ABSOLUTE_SECONDS: 30 * 86400,
      AUTH_CUSTOMER_SESSION_IDLE_SECONDS: 7 * 86400,
      AUTH_STAFF_SESSION_ABSOLUTE_SECONDS: 12 * 3600,
      AUTH_STAFF_SESSION_IDLE_SECONDS: 3600,
      AUTH_CREW_SESSION_ABSOLUTE_SECONDS: 7 * 86400,
      AUTH_CREW_SESSION_IDLE_SECONDS: 86400,
      AUTH_EMAIL_VERIFICATION_TTL_SECONDS: 86400,
      AUTH_PASSWORD_RESET_TTL_SECONDS: 1800,
      AUTH_MFA_CHALLENGE_TTL_SECONDS: 300,
      AUTH_TOTP_ENCRYPTION_KEY_VERSION: 1,
      API_TRUST_PROXY: 'none',
    });
  });

  it.each([
    ['too short', 'abc'],
    ['16 bytes', key(16)],
    ['33 bytes', key(33)],
    ['not base64', 'this is not base64 at all !!'],
  ])('rejects a TOTP encryption key that is %s', (_label, value) => {
    const message = messageOf(() => loadApiEnv(localEnv({ AUTH_TOTP_ENCRYPTION_KEY: value })));
    expect(message).toContain('AUTH_TOTP_ENCRYPTION_KEY');
    expect(message).not.toContain(value);
  });

  it('rejects CSRF/HMAC keys shorter than 32 bytes', () => {
    expect(() => loadApiEnv(localEnv({ AUTH_CSRF_KEY: key(16) }))).toThrow(/AUTH_CSRF_KEY/);
    expect(() => loadApiEnv(localEnv({ AUTH_HMAC_KEY: key(31) }))).toThrow(/AUTH_HMAC_KEY/);
  });

  it('accepts base64url keys and decodes them to raw bytes', () => {
    const raw = randomBytes(32);
    const env = loadApiEnv(localEnv({ AUTH_TOTP_ENCRYPTION_KEY: raw.toString('base64url') }));
    expect(decodeSecretKey(env.AUTH_TOTP_ENCRYPTION_KEY).equals(raw)).toBe(true);
  });

  it('refuses the same key for two purposes', () => {
    const shared = key();
    expect(() => loadApiEnv(localEnv({ AUTH_CSRF_KEY: shared, AUTH_HMAC_KEY: shared }))).toThrow(
      /must differ/,
    );
  });

  it('refuses an idle timeout longer than the absolute lifetime', () => {
    expect(() =>
      loadApiEnv(
        localEnv({
          AUTH_STAFF_SESSION_ABSOLUTE_SECONDS: '3600',
          AUTH_STAFF_SESSION_IDLE_SECONDS: '7200',
        }),
      ),
    ).toThrow(/AUTH_STAFF_SESSION_IDLE_SECONDS/);
  });

  it('requires SMTP settings when the SMTP provider is selected', () => {
    const message = messageOf(() => loadApiEnv(localEnv({ AUTH_MAIL_PROVIDER: 'smtp' })));
    expect(message).toContain('SMTP_HOST');
    expect(message).toContain('AUTH_EMAIL_FROM');
  });

  it('rejects a wildcard in realm origins', () => {
    expect(() => loadApiEnv(localEnv({ AUTH_STAFF_ORIGINS: '*' }))).toThrow(/AUTH_STAFF_ORIGINS/);
  });
});

describe('production configuration', () => {
  it('accepts a complete production configuration', () => {
    expect(() => loadApiEnv(productionEnv())).not.toThrow();
  });

  it.each(EXAMPLE_AUTH_SECRETS.map((secret, index) => [index, secret] as const))(
    'refuses example secret #%i from .env.example',
    (_index, secret) => {
      const name = ['AUTH_CSRF_KEY', 'AUTH_HMAC_KEY', 'AUTH_TOTP_ENCRYPTION_KEY'][_index] as string;
      expect(() => loadApiEnv(productionEnv({ [name]: secret }))).toThrow(
        /must not reuse the example value/,
      );
    },
  );

  it.each([
    ['disabled mail provider', { AUTH_MAIL_PROVIDER: 'disabled' }, 'AUTH_MAIL_PROVIDER'],
    ['http client URL', { CLIENT_PUBLIC_URL: 'http://client.example.test' }, 'CLIENT_PUBLIC_URL'],
    ['missing staff origins', { AUTH_STAFF_ORIGINS: '' }, 'AUTH_STAFF_ORIGINS'],
    ['http crew origin', { AUTH_CREW_ORIGINS: 'http://crew.example.test' }, 'AUTH_CREW_ORIGINS'],
    ['non-production NODE_ENV', { NODE_ENV: 'development' }, 'NODE_ENV'],
  ])('refuses %s', (_label, overrides, variable) => {
    expect(() => loadApiEnv(productionEnv(overrides))).toThrow(new RegExp(variable));
  });

  it('keeps .env.example in sync with the refused example secrets', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    for (const name of ['AUTH_CSRF_KEY', 'AUTH_HMAC_KEY', 'AUTH_TOTP_ENCRYPTION_KEY']) {
      const value = new RegExp(`^${name}=(.*)$`, 'm').exec(example)?.[1];
      expect(value, `${name} in .env.example`).toBeDefined();
      expect(EXAMPLE_AUTH_SECRETS).toContain(value);
    }
  });
});
