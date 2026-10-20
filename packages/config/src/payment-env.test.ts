import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_PAYMENT_SANDBOX_WEBHOOK_SECRET,
  loadApiEnv,
  STRIPE_LIVE_MODE_ENABLED,
} from './index.js';

const key = (bytes = 32) => randomBytes(bytes).toString('base64');
/** Synthetic Stripe-shaped values, generated at run time (never a real key). */
const stripeKey = (mode: 'test' | 'live', kind: 'sk' | 'rk' = 'sk') =>
  `${kind}_${mode}_${randomBytes(24).toString('hex')}`;
const stripeWebhookSecret = () => `whsec_${randomBytes(24).toString('hex')}`;

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

describe('Stripe configuration (PAY-EU-1)', () => {
  const stripe = (mode: string, secretKey?: string, webhookSecret?: string) => ({
    PAYMENT_STRIPE_MODE: mode,
    ...(secretKey === undefined ? {} : { PAYMENT_STRIPE_SECRET_KEY: secretKey }),
    ...(webhookSecret === undefined ? {} : { PAYMENT_STRIPE_WEBHOOK_SECRET: webhookSecret }),
  });

  it('is DISABLED by default and needs no key', () => {
    const loaded = loadApiEnv(env());
    expect(loaded.PAYMENT_STRIPE_MODE).toBe('DISABLED');
    expect(loaded.PAYMENT_STRIPE_SECRET_KEY).toBeUndefined();
    expect(loaded.PAYMENT_STRIPE_WEBHOOK_SECRET).toBeUndefined();
    // An empty line of an env file is the same as an unset variable.
    expect(loadApiEnv(env(stripe('DISABLED', '', ''))).PAYMENT_STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('refuses a key while DISABLED: no half-configured Stripe', () => {
    expect(() => loadApiEnv(env(stripe('DISABLED', stripeKey('test'))))).toThrow(
      /PAYMENT_STRIPE_SECRET_KEY: must be unset when PAYMENT_STRIPE_MODE=DISABLED/,
    );
    expect(() => loadApiEnv(env(stripe('DISABLED', undefined, stripeWebhookSecret())))).toThrow(
      /PAYMENT_STRIPE_WEBHOOK_SECRET: must be unset when PAYMENT_STRIPE_MODE=DISABLED/,
    );
  });

  it('accepts TEST with test keys in local and ci', () => {
    for (const appEnv of ['local', 'ci']) {
      for (const kind of ['sk', 'rk'] as const) {
        const secretKey = stripeKey('test', kind);
        const loaded = loadApiEnv(
          env({ APP_ENV: appEnv, ...stripe('TEST', secretKey, stripeWebhookSecret()) }),
        );
        expect(loaded.PAYMENT_STRIPE_MODE).toBe('TEST');
        expect(loaded.PAYMENT_STRIPE_SECRET_KEY).toBe(secretKey);
        // Stripe is independent of the SANDBOX setting.
        expect(loaded.PAYMENT_PROVIDER).toBe('DISABLED');
      }
    }
  });

  it.each([
    ['without any key', stripe('TEST'), /PAYMENT_STRIPE_SECRET_KEY: is required/],
    [
      'without its webhook secret',
      stripe('TEST', stripeKey('test')),
      /PAYMENT_STRIPE_WEBHOOK_SECRET: is required/,
    ],
    [
      'without its secret key',
      stripe('TEST', undefined, stripeWebhookSecret()),
      /PAYMENT_STRIPE_SECRET_KEY: is required/,
    ],
    [
      'with a live key',
      stripe('TEST', stripeKey('live'), stripeWebhookSecret()),
      /PAYMENT_STRIPE_SECRET_KEY: must be a test key/,
    ],
    [
      'with a publishable key',
      stripe('TEST', `pk_test_${randomBytes(24).toString('hex')}`, stripeWebhookSecret()),
      /PAYMENT_STRIPE_SECRET_KEY: must be a Stripe secret or restricted key/,
    ],
    [
      'with a malformed webhook secret',
      stripe('TEST', stripeKey('test'), randomBytes(24).toString('hex')),
      /PAYMENT_STRIPE_WEBHOOK_SECRET: must be a Stripe webhook signing secret/,
    ],
    [
      'with an unknown mode',
      stripe('SANDBOX'),
      /PAYMENT_STRIPE_MODE: must be DISABLED, TEST or LIVE/,
    ],
  ])('refuses Stripe %s', (_label, overrides, message) => {
    expect(() => loadApiEnv(env(overrides))).toThrow(message);
  });

  it.each(['staging', 'production'] as const)('refuses TEST in %s', (appEnv) => {
    expect(() =>
      loadApiEnv(deployedEnv(appEnv, stripe('TEST', stripeKey('test'), stripeWebhookSecret()))),
    ).toThrow(/PAYMENT_STRIPE_MODE: TEST is allowed in local and ci only/);
    expect(loadApiEnv(deployedEnv(appEnv)).PAYMENT_STRIPE_MODE).toBe('DISABLED');
  });

  it('refuses LIVE in every environment: the release gate is closed', () => {
    expect(STRIPE_LIVE_MODE_ENABLED).toBe(false);
    for (const target of [env(), deployedEnv('staging'), deployedEnv('production')]) {
      const live = { ...target, ...stripe('LIVE', stripeKey('live'), stripeWebhookSecret()) };
      expect(() => loadApiEnv(live)).toThrow(/PAYMENT_STRIPE_MODE: LIVE is not enabled/);
    }
    // LIVE also needs live keys: a test key is named as the second problem.
    expect(() =>
      loadApiEnv(
        deployedEnv('production', stripe('LIVE', stripeKey('test'), stripeWebhookSecret())),
      ),
    ).toThrow(/PAYMENT_STRIPE_SECRET_KEY: must be a live key/);
    expect(() => loadApiEnv(deployedEnv('production', stripe('LIVE')))).toThrow(
      /PAYMENT_STRIPE_SECRET_KEY: is required when PAYMENT_STRIPE_MODE=LIVE/,
    );
  });

  it('never prints a Stripe secret in a configuration error', () => {
    const secretKey = stripeKey('live');
    const webhookSecret = stripeWebhookSecret();
    let message = '';
    try {
      loadApiEnv(deployedEnv('staging', stripe('TEST', secretKey, webhookSecret)));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PAYMENT_STRIPE');
    expect(message).not.toContain(secretKey);
    expect(message).not.toContain(webhookSecret);
    expect(message).not.toContain(secretKey.slice(8, 24));
  });

  it('documents the Stripe variables as DISABLED, without any value, in .env.example', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    expect(/^PAYMENT_STRIPE_MODE=(.*)$/m.exec(example)?.[1]).toBe('DISABLED');
    expect(example).not.toMatch(/^PAYMENT_STRIPE_SECRET_KEY=./m);
    expect(example).not.toMatch(/^PAYMENT_STRIPE_WEBHOOK_SECRET=./m);
    expect(example).not.toMatch(/(sk|rk|pk)_(test|live)_[A-Za-z0-9]{8,}/);
  });
});
