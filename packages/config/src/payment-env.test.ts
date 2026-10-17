import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_PAYMENT_SANDBOX_WEBHOOK_SECRET, loadApiEnv } from './index.js';

const key = (bytes = 32) => randomBytes(bytes).toString('base64');

function env(overrides: Record<string, string> = {}) {
  return {
    APP_ENV: 'local',
    DATABASE_URL: 'postgresql://user:placeholder@localhost:5432/euroteranga_test',
    AUTH_CSRF_KEY: key(),
    AUTH_HMAC_KEY: key(),
    AUTH_TOTP_ENCRYPTION_KEY: key(),
    AUTH_MAIL_PROVIDER: 'disabled',
    CLIENT_PUBLIC_URL: 'http://localhost:3002',
    OPS_PUBLIC_URL: 'http://localhost:3004',
    ...overrides,
  };
}

function deployedEnv(appEnv: 'staging' | 'production', overrides: Record<string, string> = {}) {
  return env({
    APP_ENV: appEnv,
    NODE_ENV: 'production',
    API_TRUST_PROXY: 'loopback',
    AUTH_MAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    AUTH_EMAIL_FROM: 'no-reply@example.test',
    CLIENT_PUBLIC_URL: 'https://client.example.test',
    OPS_PUBLIC_URL: 'https://ops.example.test',
    AUTH_CUSTOMER_ORIGINS: 'https://client.example.test',
    AUTH_STAFF_ORIGINS: 'https://ops.example.test',
    AUTH_CREW_ORIGINS: 'https://crew.example.test',
    ...overrides,
  });
}

describe('payment configuration', () => {
  it('disables payments by default: no provider, no secret needed', () => {
    const loaded = loadApiEnv(env());
    expect(loaded.PAYMENT_PROVIDER).toBe('DISABLED');
    expect(loaded.PAYMENT_SANDBOX_WEBHOOK_SECRET).toBeUndefined();
  });

  it('accepts SANDBOX with its own webhook key in local and ci', () => {
    for (const appEnv of ['local', 'ci']) {
      const secret = key(48);
      const loaded = loadApiEnv(
        env({
          APP_ENV: appEnv,
          PAYMENT_PROVIDER: 'SANDBOX',
          PAYMENT_SANDBOX_WEBHOOK_SECRET: secret,
        }),
      );
      expect(loaded.PAYMENT_PROVIDER).toBe('SANDBOX');
      expect(loaded.PAYMENT_SANDBOX_WEBHOOK_SECRET).toBe(secret);
    }
  });

  it.each([
    ['without its webhook key', {}, /PAYMENT_SANDBOX_WEBHOOK_SECRET: is required/],
    [
      'with a short webhook key',
      { PAYMENT_SANDBOX_WEBHOOK_SECRET: key(16) },
      /PAYMENT_SANDBOX_WEBHOOK_SECRET: must decode to at least 32 bytes/,
    ],
    [
      'with a non-base64 webhook key',
      { PAYMENT_SANDBOX_WEBHOOK_SECRET: 'not base64 !' },
      /PAYMENT_SANDBOX_WEBHOOK_SECRET: must be base64 encoded/,
    ],
  ])('refuses SANDBOX %s', (_label, overrides, message) => {
    expect(() => loadApiEnv(env({ PAYMENT_PROVIDER: 'SANDBOX', ...overrides }))).toThrow(message);
  });

  it('refuses a webhook key reused from an authentication key', () => {
    const shared = key();
    expect(() =>
      loadApiEnv(
        env({
          AUTH_HMAC_KEY: shared,
          PAYMENT_PROVIDER: 'SANDBOX',
          PAYMENT_SANDBOX_WEBHOOK_SECRET: shared,
        }),
      ),
    ).toThrow(/must differ from the authentication keys/);
  });

  it('refuses unknown providers: no real PSP exists yet', () => {
    for (const provider of ['STRIPE', 'sandbox', 'WAVE', '']) {
      expect(() => loadApiEnv(env({ PAYMENT_PROVIDER: provider }))).toThrow(
        /PAYMENT_PROVIDER: must be SANDBOX or DISABLED/,
      );
    }
  });

  it.each(['staging', 'production'] as const)(
    'refuses SANDBOX in %s, and accepts payments DISABLED there',
    (appEnv) => {
      expect(() =>
        loadApiEnv(
          deployedEnv(appEnv, {
            PAYMENT_PROVIDER: 'SANDBOX',
            PAYMENT_SANDBOX_WEBHOOK_SECRET: key(),
          }),
        ),
      ).toThrow(/PAYMENT_PROVIDER: SANDBOX is a test provider/);
      expect(loadApiEnv(deployedEnv(appEnv)).PAYMENT_PROVIDER).toBe('DISABLED');
    },
  );

  it('keeps the development example key of .env.example in sync', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const value = /^PAYMENT_SANDBOX_WEBHOOK_SECRET=(.*)$/m.exec(example)?.[1];
    expect(value).toBe(EXAMPLE_PAYMENT_SANDBOX_WEBHOOK_SECRET);
    expect(/^PAYMENT_PROVIDER=(.*)$/m.exec(example)?.[1]).toBe('SANDBOX');
    expect(Buffer.from(EXAMPLE_PAYMENT_SANDBOX_WEBHOOK_SECRET, 'base64').toString('utf8')).toBe(
      'dev-only-sandbox-webhook-not-a-secret',
    );
  });
});
