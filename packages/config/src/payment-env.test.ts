import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_PAYMENT_SANDBOX_WEBHOOK_SECRET,
  loadApiEnv,
  PAYPAL_LIVE_MODE_ENABLED,
  STRIPE_LIVE_MODE_ENABLED,
  WAVE_LIVE_MODE_ENABLED,
} from './index.js';

const key = (bytes = 32) => randomBytes(bytes).toString('base64');
/** Synthetic Stripe-shaped values, generated at run time (never a real key). */
const stripeKey = (mode: 'test' | 'live', kind: 'sk' | 'rk' = 'sk') =>
  `${kind}_${mode}_${randomBytes(24).toString('hex')}`;
const stripeWebhookSecret = () => `whsec_${randomBytes(24).toString('hex')}`;
/** Synthetic PayPal-shaped credentials, generated at run time. */
const paypalCredential = () => randomBytes(36).toString('base64url');
const paypalWebhookId = () => randomBytes(10).toString('hex').toUpperCase();

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

describe('PayPal configuration (PAY-PAYPAL-1)', () => {
  const paypal = (
    mode: string,
    values: { clientId?: string; clientSecret?: string; webhookId?: string } = {},
  ) => ({
    PAYMENT_PAYPAL_MODE: mode,
    ...(values.clientId === undefined ? {} : { PAYMENT_PAYPAL_CLIENT_ID: values.clientId }),
    ...(values.clientSecret === undefined
      ? {}
      : { PAYMENT_PAYPAL_CLIENT_SECRET: values.clientSecret }),
    ...(values.webhookId === undefined ? {} : { PAYMENT_PAYPAL_WEBHOOK_ID: values.webhookId }),
  });
  const complete = () => ({
    clientId: paypalCredential(),
    clientSecret: paypalCredential(),
    webhookId: paypalWebhookId(),
  });

  it('is DISABLED by default and needs no credential', () => {
    const loaded = loadApiEnv(env());
    expect(loaded.PAYMENT_PAYPAL_MODE).toBe('DISABLED');
    expect(loaded.PAYMENT_PAYPAL_CLIENT_ID).toBeUndefined();
    expect(loaded.PAYMENT_PAYPAL_CLIENT_SECRET).toBeUndefined();
    expect(loaded.PAYMENT_PAYPAL_WEBHOOK_ID).toBeUndefined();
    const empty = loadApiEnv(
      env(paypal('DISABLED', { clientId: '', clientSecret: '', webhookId: '' })),
    );
    expect(empty.PAYMENT_PAYPAL_CLIENT_SECRET).toBeUndefined();
  });

  it.each([
    ['client ID', { clientId: paypalCredential() }, 'PAYMENT_PAYPAL_CLIENT_ID'],
    ['client secret', { clientSecret: paypalCredential() }, 'PAYMENT_PAYPAL_CLIENT_SECRET'],
    ['webhook ID', { webhookId: paypalWebhookId() }, 'PAYMENT_PAYPAL_WEBHOOK_ID'],
  ])('refuses a stale %s while DISABLED', (_label, values, name) => {
    expect(() => loadApiEnv(env(paypal('DISABLED', values)))).toThrow(
      new RegExp(`${name}: must be unset when PAYMENT_PAYPAL_MODE=DISABLED`),
    );
  });

  it('accepts SANDBOX with complete credentials in local and ci, next to Stripe', () => {
    for (const appEnv of ['local', 'ci']) {
      const values = complete();
      const loaded = loadApiEnv(env({ APP_ENV: appEnv, ...paypal('SANDBOX', values) }));
      expect(loaded.PAYMENT_PAYPAL_MODE).toBe('SANDBOX');
      expect(loaded.PAYMENT_PAYPAL_WEBHOOK_ID).toBe(values.webhookId);
      expect(loaded.PAYMENT_STRIPE_MODE).toBe('DISABLED');
      expect(loaded.PAYMENT_PROVIDER).toBe('DISABLED');
    }
  });

  it.each([
    ['client ID', 'clientId', 'PAYMENT_PAYPAL_CLIENT_ID'],
    ['client secret', 'clientSecret', 'PAYMENT_PAYPAL_CLIENT_SECRET'],
    ['webhook ID', 'webhookId', 'PAYMENT_PAYPAL_WEBHOOK_ID'],
  ] as const)('refuses SANDBOX without its %s', (_label, missing, name) => {
    const values: Record<string, string> = complete();
    delete values[missing];
    expect(() => loadApiEnv(env(paypal('SANDBOX', values)))).toThrow(
      new RegExp(`${name}: is required when PAYMENT_PAYPAL_MODE=SANDBOX`),
    );
  });

  it('refuses malformed values and a secret equal to the client ID', () => {
    expect(() =>
      loadApiEnv(env(paypal('SANDBOX', { ...complete(), webhookId: 'WH-not/valid' }))),
    ).toThrow(/PAYMENT_PAYPAL_WEBHOOK_ID: must be a PayPal webhook ID/);
    expect(() => loadApiEnv(env(paypal('SANDBOX', { ...complete(), clientId: 'short' })))).toThrow(
      /PAYMENT_PAYPAL_CLIENT_ID: must be a PayPal REST app client ID/,
    );
    const same = paypalCredential();
    expect(() =>
      loadApiEnv(env(paypal('SANDBOX', { ...complete(), clientId: same, clientSecret: same }))),
    ).toThrow(/PAYMENT_PAYPAL_CLIENT_SECRET: must differ from PAYMENT_PAYPAL_CLIENT_ID/);
    expect(() => loadApiEnv(env(paypal('TEST')))).toThrow(
      /PAYMENT_PAYPAL_MODE: must be DISABLED, SANDBOX or LIVE/,
    );
  });

  it.each(['staging', 'production'] as const)('refuses SANDBOX in %s', (appEnv) => {
    expect(() => loadApiEnv(deployedEnv(appEnv, paypal('SANDBOX', complete())))).toThrow(
      /PAYMENT_PAYPAL_MODE: SANDBOX is allowed in local and ci only/,
    );
    expect(loadApiEnv(deployedEnv(appEnv)).PAYMENT_PAYPAL_MODE).toBe('DISABLED');
  });

  it('refuses LIVE in every environment: the release gate is closed', () => {
    expect(PAYPAL_LIVE_MODE_ENABLED).toBe(false);
    for (const target of [env(), deployedEnv('staging'), deployedEnv('production')]) {
      expect(() => loadApiEnv({ ...target, ...paypal('LIVE', complete()) })).toThrow(
        /PAYMENT_PAYPAL_MODE: LIVE is not enabled/,
      );
    }
    expect(() => loadApiEnv(deployedEnv('production', paypal('LIVE')))).toThrow(
      /PAYMENT_PAYPAL_CLIENT_SECRET: is required when PAYMENT_PAYPAL_MODE=LIVE/,
    );
  });

  it('never prints a PayPal credential in a configuration error', () => {
    const values = complete();
    let message = '';
    try {
      loadApiEnv(deployedEnv('staging', paypal('SANDBOX', values)));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PAYMENT_PAYPAL_MODE');
    for (const value of Object.values(values)) expect(message).not.toContain(value);
  });

  it('documents PayPal as DISABLED, without any value, in .env.example', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    expect(/^PAYMENT_PAYPAL_MODE=(.*)$/m.exec(example)?.[1]).toBe('DISABLED');
    for (const name of [
      'PAYMENT_PAYPAL_CLIENT_ID',
      'PAYMENT_PAYPAL_CLIENT_SECRET',
      'PAYMENT_PAYPAL_WEBHOOK_ID',
    ]) {
      expect(example).not.toMatch(new RegExp(`^${name}=.`, 'm'));
    }
  });
});

describe('Wave Senegal configuration (PAY-SN-1A)', () => {
  const credentials = () => ({
    PAYMENT_WAVE_API_KEY: `wave_sn_prod_${randomBytes(24).toString('hex')}`,
    PAYMENT_WAVE_WEBHOOK_SECRET: `wave_sn_WHS_${randomBytes(24).toString('hex')}`,
    PAYMENT_WAVE_REQUEST_SIGNING_SECRET: `wave_sn_AKS_${randomBytes(24).toString('hex')}`,
  });

  it('is DISABLED by default, with Orange Money blocked and no credential', () => {
    const loaded = loadApiEnv(env());
    expect(loaded.PAYMENT_WAVE_MODE).toBe('DISABLED');
    expect(loaded.PAYMENT_WAVE_API_KEY).toBeUndefined();
    expect(loaded.PAYMENT_WAVE_WEBHOOK_SECRET).toBeUndefined();
    expect(loaded.PAYMENT_WAVE_REQUEST_SIGNING_SECRET).toBeUndefined();
    expect(loaded.PAYMENT_ORANGE_MONEY_MODE).toBe('DISABLED');
  });

  it.each([
    'PAYMENT_WAVE_API_KEY',
    'PAYMENT_WAVE_WEBHOOK_SECRET',
    'PAYMENT_WAVE_REQUEST_SIGNING_SECRET',
  ] as const)('refuses stale %s while DISABLED', (name) => {
    const values = credentials();
    expect(() => loadApiEnv(env({ [name]: values[name] }))).toThrow(
      new RegExp(`${name}: must be unset when PAYMENT_WAVE_MODE=DISABLED`),
    );
  });

  it('refuses LIVE in every environment and requires the complete signed setup', () => {
    expect(WAVE_LIVE_MODE_ENABLED).toBe(false);
    for (const target of [env(), deployedEnv('staging'), deployedEnv('production')]) {
      expect(() => loadApiEnv({ ...target, PAYMENT_WAVE_MODE: 'LIVE', ...credentials() })).toThrow(
        /PAYMENT_WAVE_MODE: LIVE is not enabled/,
      );
    }
    expect(() => loadApiEnv(env({ PAYMENT_WAVE_MODE: 'LIVE' }))).toThrow(
      /PAYMENT_WAVE_API_KEY: is required when PAYMENT_WAVE_MODE=LIVE/,
    );
  });

  it('refuses malformed credentials without printing their values', () => {
    const malformed = `wave_sn_wrong_${randomBytes(24).toString('hex')}`;
    let message = '';
    try {
      loadApiEnv(
        env({
          PAYMENT_WAVE_MODE: 'LIVE',
          ...credentials(),
          PAYMENT_WAVE_API_KEY: malformed,
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PAYMENT_WAVE_API_KEY');
    expect(message).not.toContain(malformed);
  });

  it('does not invent a Wave sandbox or an Orange test/live mode', () => {
    expect(() => loadApiEnv(env({ PAYMENT_WAVE_MODE: 'SANDBOX' }))).toThrow(
      /PAYMENT_WAVE_MODE: must be DISABLED or LIVE/,
    );
    for (const mode of ['TEST', 'LIVE']) {
      expect(() => loadApiEnv(env({ PAYMENT_ORANGE_MONEY_MODE: mode }))).toThrow(
        /PAYMENT_ORANGE_MONEY_MODE/,
      );
    }
  });

  it('documents both methods as disabled and no secret in .env.example', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    expect(/^PAYMENT_WAVE_MODE=(.*)$/m.exec(example)?.[1]).toBe('DISABLED');
    expect(/^PAYMENT_ORANGE_MONEY_MODE=(.*)$/m.exec(example)?.[1]).toBe('DISABLED');
    for (const name of [
      'PAYMENT_WAVE_API_KEY',
      'PAYMENT_WAVE_WEBHOOK_SECRET',
      'PAYMENT_WAVE_REQUEST_SIGNING_SECRET',
    ]) {
      expect(example).not.toMatch(new RegExp(`^${name}=.`, 'm'));
    }
    const orange = readFileSync(
      new URL('../../../docs/payments/orange-money-senegal.md', import.meta.url),
      'utf8',
    );
    expect(orange).toContain('ORANGE_MONEY_ADAPTER=BLOCKED_PENDING_OFFICIAL_MERCHANT_DOCS');
  });
});
