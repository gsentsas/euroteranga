import { decodeSecretKey, type ApiEnv } from '@euroteranga/config';

export interface StripeConfig {
  mode: 'TEST' | 'LIVE';
  /** Server-side only: never logged, never returned. */
  secretKey: string;
  webhookSecret: string;
}

export interface PaymentConfig {
  /** Configured provider; DISABLED refuses every payment initiation. */
  provider: 'SANDBOX' | 'DISABLED';
  /** HMAC key of the SANDBOX webhook signatures (raw bytes), server-side only. */
  sandboxWebhookKey: Buffer | null;
  /** Stripe (PAY-EU-1): null while PAYMENT_STRIPE_MODE=DISABLED, the default. */
  stripe: StripeConfig | null;
  /** Where a provider's page sends the customer back: the client area. It confirms nothing. */
  returnUrl: string;
}

export const PAYMENT_CONFIG = Symbol('PAYMENT_CONFIG');

export function buildPaymentConfig(env: ApiEnv): PaymentConfig {
  const stripeMode = env.PAYMENT_STRIPE_MODE;
  return {
    provider: env.PAYMENT_PROVIDER,
    sandboxWebhookKey:
      env.PAYMENT_PROVIDER === 'SANDBOX' && env.PAYMENT_SANDBOX_WEBHOOK_SECRET
        ? decodeSecretKey(env.PAYMENT_SANDBOX_WEBHOOK_SECRET)
        : null,
    // The configuration has already refused an incomplete or mismatched setup.
    stripe:
      stripeMode !== 'DISABLED' &&
      env.PAYMENT_STRIPE_SECRET_KEY &&
      env.PAYMENT_STRIPE_WEBHOOK_SECRET
        ? {
            mode: stripeMode,
            secretKey: env.PAYMENT_STRIPE_SECRET_KEY,
            webhookSecret: env.PAYMENT_STRIPE_WEBHOOK_SECRET,
          }
        : null,
    returnUrl: `${env.CLIENT_PUBLIC_URL.replace(/\/+$/, '')}/compte`,
  };
}
