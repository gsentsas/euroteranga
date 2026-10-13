import type { PaymentFailureCode } from '../payment-rules.js';

/**
 * Provider abstraction (ADR-027). The business service only talks to this
 * interface; a provider never decides a business state by itself. Results
 * always arrive as authenticated provider events through the webhook
 * pipeline, never as an immediate success returned to the service.
 */
export type PaymentProviderName = 'SANDBOX';

export interface ProviderPaymentRequest {
  /** Our public payment reference, the provider-side idempotency key. */
  paymentReference: string;
  bookingReference: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyMinorUnit: number;
}

export interface ProviderCheckout {
  /** Opaque id of the attempt at the provider (not a secret). */
  providerPaymentId: string;
  /** Where the customer completes the payment; null when nothing is collected. */
  redirectUrl: string | null;
}

/** A webhook request as received, before any parsing. */
export interface ProviderWebhookRequest {
  rawBody: Buffer | undefined;
  contentType: string | undefined;
  header: (name: string) => string | undefined;
}

/** A provider event, normalized (our types and codes, never provider text). */
export interface ProviderEvent {
  providerEventId: string;
  type: 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED';
  providerPaymentId: string;
  amountMinor: bigint;
  currencyCode: string;
  /** PAYMENT_FAILED only, already normalized. */
  failureCode: PaymentFailureCode | null;
  /** Hex SHA-256 of the raw payload (the payload itself is not stored). */
  payloadHash: string;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** True for providers that move no real money (SANDBOX). */
  readonly testMode: boolean;
  /**
   * Registers an attempt at the provider. Called before the database
   * transaction (no network call ever holds a database lock).
   */
  createPayment(request: ProviderPaymentRequest): Promise<ProviderCheckout>;
  /**
   * Authenticates a webhook: content type, size, timestamp freshness and
   * signature (constant time). Throws PAYMENT_WEBHOOK_INVALID.
   */
  verifyWebhook(request: ProviderWebhookRequest, nowMs: number): Buffer;
  /** Parses an authenticated payload. Throws PAYMENT_WEBHOOK_INVALID. */
  parseWebhook(rawBody: Buffer): ProviderEvent;
}

/** Nest injection token of the configured provider (null when DISABLED). */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
