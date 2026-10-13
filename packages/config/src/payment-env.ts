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
 */
export const PAYMENT_PROVIDERS = ['SANDBOX', 'DISABLED'] as const;

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
};

type PaymentEnvInput = z.infer<z.ZodObject<typeof paymentEnvShape>> & {
  APP_ENV: string;
  AUTH_CSRF_KEY: string;
  AUTH_HMAC_KEY: string;
  AUTH_TOTP_ENCRYPTION_KEY: string;
};

/** Cross-field rules: SANDBOX needs its own key and never runs when deployed. */
export function refinePaymentEnv(env: PaymentEnvInput, ctx: z.RefinementCtx): void {
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
