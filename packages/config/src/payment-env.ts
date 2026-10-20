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
 */
export const PAYMENT_PROVIDERS = ['SANDBOX', 'DISABLED'] as const;
export const PAYMENT_STRIPE_MODES = ['DISABLED', 'TEST', 'LIVE'] as const;

/**
 * Release gate of PAYMENT_STRIPE_MODE=LIVE. The pilot takes no real money:
 * going live is its own reviewed change (owner approval, live webhook
 * endpoint, refund execution), never a configuration switch.
 */
export const STRIPE_LIVE_MODE_ENABLED = false;

const STRIPE_SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,240}$/;
const STRIPE_WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=]{16,240}$/;

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
