import { decodeSecretKey, type ApiEnv } from '@euroteranga/config';

export interface PaymentConfig {
  /** Configured provider; DISABLED refuses every payment initiation. */
  provider: 'SANDBOX' | 'DISABLED';
  /** HMAC key of the SANDBOX webhook signatures (raw bytes), server-side only. */
  sandboxWebhookKey: Buffer | null;
}

export const PAYMENT_CONFIG = Symbol('PAYMENT_CONFIG');

export function buildPaymentConfig(env: ApiEnv): PaymentConfig {
  return {
    provider: env.PAYMENT_PROVIDER,
    sandboxWebhookKey:
      env.PAYMENT_PROVIDER === 'SANDBOX' && env.PAYMENT_SANDBOX_WEBHOOK_SECRET
        ? decodeSecretKey(env.PAYMENT_SANDBOX_WEBHOOK_SECRET)
        : null,
  };
}
