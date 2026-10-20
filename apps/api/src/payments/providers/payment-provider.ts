import type { PaymentFailureCode } from '../payment-rules.js';
import type {
  CardNetwork,
  PayerCountry,
  PaymentMethodCode,
  PaymentProviderCode,
} from '../payment-catalog.js';

/**
 * Provider abstraction (ADR-027). The business service only talks to this
 * interface; a provider never decides a business state by itself. Results
 * always arrive as authenticated provider events through the webhook
 * pipeline, never as an immediate success returned to the service.
 */
export type PaymentProviderName = PaymentProviderCode;

/** Presentment amount bounds of one method, in minor units (inclusive). */
export interface ProviderAmountLimit {
  minMinor: bigint;
  maxMinor: bigint;
}

/** Why a provider able to offer a method does not collect it for EURO TERANGA. */
export type ProviderExclusionReason =
  | 'ASYNC_SETTLEMENT_REQUIRES_BOOKING_POLICY'
  | 'BUSINESS_CATEGORY_PROHIBITED'
  | 'NOT_SELECTABLE_IN_CHECKOUT'
  | 'NOT_SUPPORTED_BY_PINNED_SDK'
  | 'SEPARATE_PROVIDER_PR'
  | 'CURRENCY_NOT_SUPPORTED_BY_PROVIDER';

export interface ProviderCapability {
  providerCode: PaymentProviderCode;
  supportedMethods: readonly PaymentMethodCode[];
  payerCountries: readonly PayerCountry[];
  /** Narrower payer countries of some methods (Bizum: Spain only). */
  methodCountries: Readonly<Partial<Record<PaymentMethodCode, readonly PayerCountry[]>>>;
  supportedCurrencies: readonly string[];
  /** Presentment amount bounds per method and payer country, when the provider has some. */
  amountLimits: Readonly<
    Partial<Record<PaymentMethodCode, Readonly<Partial<Record<PayerCountry, ProviderAmountLimit>>>>>
  >;
  /** Networks this provider accepts for CARD, per payer country: badges only. */
  cardNetworks: Readonly<Partial<Record<PayerCountry, readonly CardNetwork[]>>>;
  /**
   * Wallets the provider's card page may add on an eligible device. Device
   * eligibility is unknown to EURO TERANGA: never a promise, never a choice.
   */
  deviceWallets: readonly ('APPLE_PAY' | 'GOOGLE_PAY')[];
  /**
   * How long the provider's checkout stays payable after the attempt is
   * created; null when it has no expiry of its own (SANDBOX).
   */
  collectionWindowSeconds: number | null;
  /**
   * Hold time that must remain when the attempt starts: the collection window
   * plus a margin, so the checkout always closes before the seats are freed.
   */
  minimumHoldRemainingSeconds: number;
  /** Methods documented by the provider but not collected for EURO TERANGA, with the reason. */
  excludedMethods: readonly { method: PaymentMethodCode; reason: ProviderExclusionReason }[];
  /**
   * True when no money can move unless EURO TERANGA itself asks for it later
   * (SANDBOX; PayPal, which collects only on our capture): cancelling the
   * attempt locally is then enough to prevent collection
   * (LOCAL_CANCEL_PREVENTS_CAPTURE). False for a provider whose own checkout
   * collects by itself (Stripe): it needs `cancelPayment` first.
   */
  localCancelPreventsCollection: boolean;
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
  /**
   * When the provider's checkout must stop accepting the payment: the
   * attempt's creation plus the provider's collection window, always before
   * the hold expires. Derived from the stored attempt, so a replay sends the
   * same value. Null when the provider has no expiry of its own.
   */
  expiresAt: Date | null;
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
 * A terminal provider event, normalized (our types and codes, never provider
 * text). amountMinor and currencyCode are what the provider collected: they
 * are compared with the quote's presentment amount. A failure moves no money,
 * so a provider may omit its amount (PayPal's approval reversal): null then.
 * A success without an amount is refused (AMOUNT_MISMATCH).
 */
export interface ProviderEvent {
  providerEventId: string;
  type: 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED';
  providerPaymentId: string;
  /** Provider-echoed Payment.reference, when its contract exposes one. */
  paymentReference?: string;
  amountMinor: bigint | null;
  currencyCode: string | null;
  /** PAYMENT_FAILED only, already normalized. */
  failureCode: PaymentFailureCode | null;
  /** Hex SHA-256 of the raw payload (the payload itself is not stored). */
  payloadHash: string;
}

/**
 * A non-terminal provider event (PAY-PAYPAL-1): the payer approved the
 * payment at the provider, which takes no money yet. EURO TERANGA then
 * decides whether to capture; only the capture's own terminal event can
 * succeed the attempt. The amount, when the provider includes it, must equal
 * the quote's presentment before any capture.
 */
export interface ProviderApproval {
  type: 'PAYMENT_APPROVED';
  providerEventId: string;
  providerPaymentId: string;
  amountMinor: bigint | null;
  currencyCode: string | null;
  payloadHash: string;
}

/** What a capture request became at the provider, as far as it says synchronously. */
export type ProviderCaptureResult = 'CAPTURE_REQUESTED' | 'ALREADY_CAPTURED' | 'NOT_CAPTURABLE';

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
   * signature (constant time). Throws PAYMENT_WEBHOOK_INVALID. A provider
   * whose signature can only be checked by its own API (PayPal) answers
   * asynchronously; it then throws PAYMENT_PROVIDER_UNAVAILABLE when that
   * check cannot be completed (fail closed: the provider retries).
   */
  verifyWebhook(request: ProviderWebhookRequest, nowMs: number): Buffer | Promise<Buffer>;
  /**
   * Parses an authenticated payload. Throws PAYMENT_WEBHOOK_INVALID. Returns
   * null for an authentic event that carries no payment result (a delayed
   * payment still processing, an event type we do not use): it is
   * acknowledged and changes nothing. A provider with a separate capture step
   * (PayPal) also returns approvals.
   */
  parseWebhook(rawBody: Buffer): ProviderEvent | ProviderApproval | null;
  /**
   * Captures an approved payment (PayPal), outside any transaction, with a
   * deterministic idempotency key: the same approval delivered twice is the
   * same capture. The result never confirms anything: the capture's own
   * signed event does. Throws PAYMENT_PROVIDER_UNAVAILABLE when the outcome
   * is unknown (a timeout), so the approval is redelivered and retried.
   */
  capturePayment?(
    providerPaymentId: string,
    idempotencyKey: string,
  ): Promise<ProviderCaptureResult>;
  /**
   * Closes the provider's checkout of a PENDING attempt before EURO TERANGA
   * cancels it, so the customer can no longer pay there. CLOSED: it can no
   * longer be paid (closed now, or already expired). COMPLETED: the payer
   * already finished, so the provider's event decides the attempt and it is
   * not cancelled. Providers without a payable checkout of their own
   * (SANDBOX) do not implement it.
   */
  cancelPayment?(providerPaymentId: string): Promise<'CLOSED' | 'COMPLETED'>;
}

/** Nest injection token of every configured adapter (empty when DISABLED). */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
