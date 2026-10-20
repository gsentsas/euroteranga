import { z } from 'zod';
import { secretKey } from './auth-env.js';

/**
 * Payment settings (PR-10). Server-side only.
 *
 * - PAYMENT_PROVIDER: SANDBOX (local, test-only provider: no external call,
 *   no real money) or DISABLED (default: payment initiation is refused).
 *   There is no real payment service provider yet; SANDBOX is refused in
 *   staging and production.
 * - PAYMENT_SANDBOX_WEBHOOK_SECRET: HMAC key of the SANDBOX webhook
 *   signatures, base64, at least 32 bytes, required with SANDBOX. Never a
 *   NEXT_PUBLIC_ value, never sent to a browser.
 *
 * Stripe (PAY-EU-1), independent of PAYMENT_PROVIDER (several providers can
 * be configured side by side):
 *
 * - PAYMENT_STRIPE_MODE: DISABLED (default: no key, no adapter, no network
 *   call), TEST (Stripe test keys, local and CI only) or LIVE (live keys;
 *   refused in this release: the pilot never takes real money).
 * - PAYMENT_STRIPE_SECRET_KEY: secret or restricted API key of that mode
 *   (sk_test_/rk_test_ in TEST, sk_live_/rk_live_ in LIVE).
 * - PAYMENT_STRIPE_WEBHOOK_SECRET: signing secret of the Stripe webhook
 *   endpoint (whsec_...).
 *
 * Both Stripe secrets are server-side only, never NEXT_PUBLIC_ values, never
 * logged, and must be unset while Stripe is DISABLED. No publishable key is
 * needed: the customer pays on the page hosted by Stripe (Checkout).
 *
 * PayPal (PAY-PAYPAL-1), independent as well:
 *
 * - PAYMENT_PAYPAL_MODE: DISABLED (default: no credential, no adapter, no
 *   network call), SANDBOX (PayPal sandbox credentials, local and CI only) or
 *   LIVE (refused in this release).
 * - PAYMENT_PAYPAL_CLIENT_ID, PAYMENT_PAYPAL_CLIENT_SECRET: the REST app's
 *   OAuth 2.0 client credentials. The flow is server-side only, so neither is
 *   ever sent to a browser; the secret is never logged.
 * - PAYMENT_PAYPAL_WEBHOOK_ID: the ID of the webhook configured for that app,
 *   which PayPal's signature verification needs. Not a secret, but it only
 *   ever comes from this configuration, never from a request.
 *
 * All three must be unset while PayPal is DISABLED.
 */
export const PAYMENT_PROVIDERS = ['SANDBOX', 'DISABLED'] as const;
export const PAYMENT_STRIPE_MODES = ['DISABLED', 'TEST', 'LIVE'] as const;
export const PAYMENT_PAYPAL_MODES = ['DISABLED', 'SANDBOX', 'LIVE'] as const;

/**
 * Release gate of PAYMENT_STRIPE_MODE=LIVE. The pilot takes no real money:
 * going live is its own reviewed change (owner approval, live webhook
 * endpoint, refund execution), never a configuration switch.
 */
export const STRIPE_LIVE_MODE_ENABLED = false;

/** Release gate of PAYMENT_PAYPAL_MODE=LIVE, closed for the same reasons. */
export const PAYPAL_LIVE_MODE_ENABLED = false;

const STRIPE_SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,240}$/;
const STRIPE_WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=]{16,240}$/;
/** REST app credentials (opaque to us) and webhook ID (Webhooks API: `^[a-zA-Z0-9]+$`, 50 max). */
const PAYPAL_CREDENTIAL = /^[A-Za-z0-9_-]{16,256}$/;
const PAYPAL_WEBHOOK_ID = /^[A-Za-z0-9]{1,50}$/;

/** An empty value (`NAME=` in an env file) is the same as an unset one. */
const optionalSecret = (pattern: RegExp, message: string) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(pattern, message).optional(),
  );

/**
 * Development-only example key published in `.env.example` (it decodes to
 * "dev-only-sandbox-webhook-not-a-secret"). SANDBOX itself is refused in
 * staging and production, so this value can never protect real payments.
 */
export const EXAMPLE_PAYMENT_SANDBOX_WEBHOOK_SECRET =
  'ZGV2LW9ubHktc2FuZGJveC13ZWJob29rLW5vdC1hLXNlY3JldA==';

export const paymentEnvShape = {
  PAYMENT_PROVIDER: z
    .enum(PAYMENT_PROVIDERS, { error: 'must be SANDBOX or DISABLED' })
    .default('DISABLED'),
  PAYMENT_SANDBOX_WEBHOOK_SECRET: secretKey({ minBytes: 32 }).optional(),
  PAYMENT_STRIPE_MODE: z
    .enum(PAYMENT_STRIPE_MODES, { error: 'must be DISABLED, TEST or LIVE' })
    .default('DISABLED'),
  PAYMENT_STRIPE_SECRET_KEY: optionalSecret(
    STRIPE_SECRET_KEY,
    'must be a Stripe secret or restricted key (sk_ or rk_, then test_ or live_)',
  ),
  PAYMENT_STRIPE_WEBHOOK_SECRET: optionalSecret(
    STRIPE_WEBHOOK_SECRET,
    'must be a Stripe webhook signing secret (whsec_)',
  ),
  PAYMENT_PAYPAL_MODE: z
    .enum(PAYMENT_PAYPAL_MODES, { error: 'must be DISABLED, SANDBOX or LIVE' })
    .default('DISABLED'),
  PAYMENT_PAYPAL_CLIENT_ID: optionalSecret(
    PAYPAL_CREDENTIAL,
    'must be a PayPal REST app client ID (16-256 letters, digits, - or _)',
  ),
  PAYMENT_PAYPAL_CLIENT_SECRET: optionalSecret(
    PAYPAL_CREDENTIAL,
    'must be a PayPal REST app client secret (16-256 letters, digits, - or _)',
  ),
  PAYMENT_PAYPAL_WEBHOOK_ID: optionalSecret(
    PAYPAL_WEBHOOK_ID,
    'must be a PayPal webhook ID (1-50 letters or digits)',
  ),
};

type PaymentEnvInput = z.infer<z.ZodObject<typeof paymentEnvShape>> & {
  APP_ENV: string;
  AUTH_CSRF_KEY: string;
  AUTH_HMAC_KEY: string;
  AUTH_TOTP_ENCRYPTION_KEY: string;
};

/** Cross-field rules: SANDBOX needs its own key and never runs when deployed. */
export function refinePaymentEnv(env: PaymentEnvInput, ctx: z.RefinementCtx): void {
  refineStripeEnv(env, ctx);
  refinePayPalEnv(env, ctx);
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });

  if (env.PAYMENT_PROVIDER !== 'SANDBOX') return;
  if (env.APP_ENV === 'staging' || env.APP_ENV === 'production') {
    issue(
      'PAYMENT_PROVIDER',
      'SANDBOX is a test provider and is refused in staging and production',
    );
  }
  const secret = env.PAYMENT_SANDBOX_WEBHOOK_SECRET;
  if (!secret) {
    issue('PAYMENT_SANDBOX_WEBHOOK_SECRET', 'is required when PAYMENT_PROVIDER=SANDBOX');
    return;
  }
  // One key per purpose: the webhook key never doubles as an auth key.
  if ([env.AUTH_CSRF_KEY, env.AUTH_HMAC_KEY, env.AUTH_TOTP_ENCRYPTION_KEY].includes(secret)) {
    issue('PAYMENT_SANDBOX_WEBHOOK_SECRET', 'must differ from the authentication keys');
  }
}

/**
 * Stripe fails closed: DISABLED carries no key at all; TEST needs both test
 * secrets and runs in local and CI only; LIVE needs live secrets and is
 * refused by the release gate anyway. Messages name variables, never values.
 */
function refineStripeEnv(env: PaymentEnvInput, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  const mode = env.PAYMENT_STRIPE_MODE;
  const secretKey = env.PAYMENT_STRIPE_SECRET_KEY;
  const webhookSecret = env.PAYMENT_STRIPE_WEBHOOK_SECRET;

  if (mode === 'DISABLED') {
    if (secretKey)
      issue('PAYMENT_STRIPE_SECRET_KEY', 'must be unset when PAYMENT_STRIPE_MODE=DISABLED');
    if (webhookSecret) {
      issue('PAYMENT_STRIPE_WEBHOOK_SECRET', 'must be unset when PAYMENT_STRIPE_MODE=DISABLED');
    }
    return;
  }
  if (mode === 'TEST' && env.APP_ENV !== 'local' && env.APP_ENV !== 'ci') {
    issue('PAYMENT_STRIPE_MODE', 'TEST is allowed in local and ci only');
  }
  if (mode === 'LIVE' && !STRIPE_LIVE_MODE_ENABLED) {
    issue(
      'PAYMENT_STRIPE_MODE',
      'LIVE is not enabled in this release: the pilot takes no real money',
    );
  }
  const keyMode = mode === 'TEST' ? 'test' : 'live';
  if (!secretKey) {
    issue('PAYMENT_STRIPE_SECRET_KEY', `is required when PAYMENT_STRIPE_MODE=${mode}`);
  } else if (!secretKey.startsWith(`sk_${keyMode}_`) && !secretKey.startsWith(`rk_${keyMode}_`)) {
    issue('PAYMENT_STRIPE_SECRET_KEY', `must be a ${keyMode} key when PAYMENT_STRIPE_MODE=${mode}`);
  }
  if (!webhookSecret) {
    issue('PAYMENT_STRIPE_WEBHOOK_SECRET', `is required when PAYMENT_STRIPE_MODE=${mode}`);
  }
}

const PAYPAL_VARIABLES = [
  'PAYMENT_PAYPAL_CLIENT_ID',
  'PAYMENT_PAYPAL_CLIENT_SECRET',
  'PAYMENT_PAYPAL_WEBHOOK_ID',
] as const;

/**
 * PayPal fails closed like Stripe: DISABLED carries no credential at all;
 * SANDBOX needs all three values and runs in local and CI only; LIVE is
 * refused by the release gate. Messages name variables, never values.
 */
function refinePayPalEnv(env: PaymentEnvInput, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  const mode = env.PAYMENT_PAYPAL_MODE;

  if (mode === 'DISABLED') {
    for (const name of PAYPAL_VARIABLES) {
      if (env[name]) issue(name, 'must be unset when PAYMENT_PAYPAL_MODE=DISABLED');
    }
    return;
  }
  if (mode === 'SANDBOX' && env.APP_ENV !== 'local' && env.APP_ENV !== 'ci') {
    issue('PAYMENT_PAYPAL_MODE', 'SANDBOX is allowed in local and ci only');
  }
  if (mode === 'LIVE' && !PAYPAL_LIVE_MODE_ENABLED) {
    issue(
      'PAYMENT_PAYPAL_MODE',
      'LIVE is not enabled in this release: the pilot takes no real money',
    );
  }
  for (const name of PAYPAL_VARIABLES) {
    if (!env[name]) issue(name, `is required when PAYMENT_PAYPAL_MODE=${mode}`);
  }
  if (
    env.PAYMENT_PAYPAL_CLIENT_ID &&
    env.PAYMENT_PAYPAL_CLIENT_ID === env.PAYMENT_PAYPAL_CLIENT_SECRET
  ) {
    issue('PAYMENT_PAYPAL_CLIENT_SECRET', 'must differ from PAYMENT_PAYPAL_CLIENT_ID');
  }
}
