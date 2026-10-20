import type { PaymentFailureCode } from '../payment-rules.js';
import type { PayerCountry, PaymentMethodCode, PaymentProviderCode } from '../payment-catalog.js';

/**
 * Provider abstraction (ADR-027). The business service only talks to this
 * interface; a provider never decides a business state by itself. Results
 * always arrive as authenticated provider events through the webhook
 * pipeline, never as an immediate success returned to the service.
 */
export type PaymentProviderName = PaymentProviderCode;

export interface ProviderCapability {
  providerCode: PaymentProviderCode;
  supportedMethods: readonly PaymentMethodCode[];
  payerCountries: readonly PayerCountry[];
  supportedCurrencies: readonly string[];
  testMode: boolean;
  refundCapabilities: 'NONE' | 'FULL' | 'FULL_AND_PARTIAL';
  partialRefundCapabilities: boolean;
  webhookCapabilities: readonly ('SIGNED_EVENTS' | 'REPLAY_PROTECTION' | 'TIMESTAMP_CHECK')[];
  instantConfirmation: boolean;
  requiresRedirect: boolean;
  requiresPhone: boolean;
  requiresMerchantEntityCountry: readonly PayerCountry[];
  /** Lower is preferred; it is strictly internal and never returned as a payment option. */
  priority: number;
  /** Runtime switch. A configured adapter is still unroutable while inactive. */
  active: boolean;
}

/**
 * What a provider needs to collect one attempt, and nothing more: never a
 * password, session, PIN, OTP, card number or security code (the provider
 * collects those itself, on its own pages or apps). The amount is the
 * presentment amount of the immutable quote, the one the payer was shown.
 */
export interface ProviderPaymentRequest {
  /** Our public payment reference, the provider-side idempotency key. */
  paymentReference: string;
  bookingReference: string;
  paymentMethod: PaymentMethodCode;
  payerCountry: PayerCountry;
  presentmentAmountMinor: bigint;
  presentmentCurrencyCode: string;
  presentmentCurrencyMinorUnit: number;
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

/**
 * A provider event, normalized (our types and codes, never provider text).
 * amountMinor and currencyCode are what the provider collected: they are
 * compared with the quote's presentment amount.
 */
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
  readonly capability: ProviderCapability;
  /**
   * Registers an attempt at the provider after the PENDING Payment has been
   * committed. paymentReference is a mandatory provider-side idempotency key:
   * every call with the same reference must return the same provider attempt.
   * No database transaction or lock is held during this network call.
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

/** Nest injection token of every configured adapter (empty when DISABLED). */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
