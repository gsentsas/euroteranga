import { createHash } from 'node:crypto';
import type { Logger } from '@euroteranga/logger';
import Stripe from 'stripe';
import { z } from 'zod';
import { PublicApiError } from '../../auth/http/public-api-error.js';
import { declaredCapability } from '../payment-capability.registry.js';
import { PaymentErrors } from '../payment.errors.js';
import type { PaymentMethodCode } from '../payment-catalog.js';
import { PAYMENT_REFERENCE_PATTERN } from '../payment-rules.js';
import type {
  PaymentProvider,
  ProviderCheckout,
  ProviderEvent,
  ProviderPaymentRequest,
  ProviderWebhookRequest,
} from './payment-provider.js';

/** API version of the pinned SDK (stripe 23.0.0): requests and events use it. */
export const STRIPE_API_VERSION = '2026-09-30.endive' as const;
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
/** Accepted age of a signature (Stripe's default), and of a future timestamp. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
/** Largest accepted webhook payload (the API's JSON body limit). */
export const STRIPE_MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_SIGNATURE_HEADER_LENGTH = 1024;
/** The only metadata sent to Stripe: our public payment reference. */
export const STRIPE_METADATA_KEY = 'euroteranga_payment_reference';

/**
 * Our method -> the single Checkout payment method type allowed for it
 * (`allowed_payment_method_types`): the customer can pay with that method
 * and nothing else. A method without an entry is never sent to Stripe.
 */
export const STRIPE_METHOD_TYPES = {
  CARD: 'card',
  BIZUM: 'bizum',
  KLARNA: 'klarna',
} as const satisfies Partial<
  Record<PaymentMethodCode, Stripe.Checkout.SessionCreateParams.AllowedPaymentMethodType>
>;

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,250}$/;
const CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\/[A-Za-z0-9/_\-#%.=?&]{1,2000}$/;

/** What the adapter reads of a Checkout Session; never stored, never logged. */
export interface StripeSessionSummary {
  id: string;
  url: string | null;
  amountTotal: number | null;
  currency: string | null;
  livemode: boolean;
}

/**
 * The Stripe API calls the adapter makes, behind one seam: production uses
 * the official SDK (StripeSdkGateway); tests use a fake, so CI never reaches
 * Stripe. Signature verification is not behind this seam: it always runs
 * the SDK's own code.
 */
export interface StripeGateway {
  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string,
  ): Promise<StripeSessionSummary>;
  /** Expires an open session; returns the session status afterwards. */
  expireCheckoutSession(sessionId: string): Promise<'open' | 'complete' | 'expired' | string>;
}

/** The official Stripe Node SDK, pinned to its API version. */
export class StripeSdkGateway implements StripeGateway {
  private readonly client: Stripe;

  constructor(secretKey: string) {
    this.client = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION,
      // Retries reuse the same idempotency key (SDK behaviour).
      maxNetworkRetries: 2,
      timeout: 10_000,
      telemetry: false,
      appInfo: { name: 'euroteranga-api' },
    });
  }

  async createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string,
  ): Promise<StripeSessionSummary> {
    const session = await this.client.checkout.sessions.create(params, { idempotencyKey });
    return {
      id: session.id,
      url: session.url,
      amountTotal: session.amount_total,
      currency: session.currency,
      livemode: session.livemode,
    };
  }

  async expireCheckoutSession(sessionId: string): Promise<string> {
    try {
      return (await this.client.checkout.sessions.expire(sessionId)).status ?? 'unknown';
    } catch (error) {
      // Only an open session can be expired: read what it became instead.
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) throw error;
      return (await this.client.checkout.sessions.retrieve(sessionId)).status ?? 'unknown';
    }
  }
}

export interface StripeProviderOptions {
  mode: 'TEST' | 'LIVE';
  webhookSecret: string;
  /** Where Stripe sends the customer back (the client area); confirms nothing. */
  returnUrl: string;
  gateway: StripeGateway;
  logger: Logger;
}

/** Signed, versioned snapshot event: only the fields the adapter uses. */
const eventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]{10,250}$/),
  object: z.literal('event'),
  type: z.string().min(1).max(100),
  livemode: z.boolean(),
  data: z.object({ object: z.unknown() }),
});

const sessionSchema = z.object({
  object: z.literal('checkout.session'),
  id: z.string().regex(SESSION_ID),
  amount_total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[a-z]{3}$/),
  payment_status: z.string().max(32),
  livemode: z.boolean(),
  client_reference_id: z.string().max(200).nullable(),
  metadata: z.record(z.string(), z.string()).nullable(),
});

/** Checkout events that carry a result; every other type is acknowledged and ignored. */
const RESULT_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

/** A failed Stripe call, as logged: identifiers and codes only, never the error object. */
function stripeErrorFields(error: unknown) {
  if (error instanceof Stripe.errors.StripeError) {
    return {
      stripeErrorType: error.type,
      stripeErrorCode: error.code ?? null,
      stripeStatusCode: error.statusCode ?? null,
      stripeRequestId: error.requestId ?? null,
    };
  }
  return { stripeErrorType: 'unexpected' };
}

/**
 * Stripe Europe (PAY-EU-1): hosted Checkout, EUR only, payer countries FR and
 * ES, methods CARD, BIZUM (Spain) and KLARNA. The customer pays on Stripe's
 * page; EURO TERANGA never sees a card number, security code, phone number
 * or bank account. A return from that page confirms nothing: only signed
 * Stripe events do. Disabled by default (PAYMENT_STRIPE_MODE).
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'STRIPE' as const;
  readonly testMode: boolean;
  readonly capability = declaredCapability('STRIPE');

  constructor(private readonly options: StripeProviderOptions) {
    this.testMode = options.mode === 'TEST';
  }

  async createPayment(request: ProviderPaymentRequest): Promise<ProviderCheckout> {
    const type = STRIPE_METHOD_TYPES[request.paymentMethod as keyof typeof STRIPE_METHOD_TYPES];
    // Exactly the customer's method, or nothing: never another one.
    if (!type) throw PaymentErrors.methodUnavailable();
    if (request.presentmentCurrencyCode !== 'EUR' || request.presentmentCurrencyMinorUnit !== 2) {
      throw PaymentErrors.currencyUnsupported();
    }
    const amount = Number(request.presentmentAmountMinor);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw PaymentErrors.quoteMismatch();
    if (!request.expiresAt) throw new Error('a Stripe checkout needs its collection deadline');

    const metadata = { [STRIPE_METADATA_KEY]: request.paymentReference };
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      allowed_payment_method_types: [type],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: amount,
            product_data: { name: `Réservation ${request.bookingReference}` },
          },
        },
      ],
      client_reference_id: request.paymentReference,
      metadata,
      payment_intent_data: { metadata },
      expires_at: Math.floor(request.expiresAt.getTime() / 1000),
      success_url: `${this.options.returnUrl}?paiement=retour`,
      cancel_url: `${this.options.returnUrl}?paiement=abandon`,
    };

    let session: StripeSessionSummary;
    try {
      // The payment reference is the idempotency key: a replay gets the same session.
      session = await this.options.gateway.createCheckoutSession(params, request.paymentReference);
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      this.options.logger.warn('stripe checkout session not created', {
        paymentReference: request.paymentReference,
        ...stripeErrorFields(error),
      });
      throw PaymentErrors.providerUnavailable();
    }
    // What Stripe will collect must be exactly what the payer was quoted.
    if (
      !SESSION_ID.test(session.id) ||
      !session.url ||
      !CHECKOUT_URL.test(session.url) ||
      session.amountTotal !== amount ||
      session.currency !== 'eur' ||
      session.livemode !== !this.testMode
    ) {
      this.options.logger.warn('stripe checkout session refused', {
        paymentReference: request.paymentReference,
      });
      throw PaymentErrors.providerUnavailable();
    }
    return { providerPaymentId: session.id, redirectUrl: session.url };
  }

  async cancelPayment(providerPaymentId: string): Promise<'CLOSED' | 'COMPLETED'> {
    let status: string;
    try {
      status = await this.options.gateway.expireCheckoutSession(providerPaymentId);
    } catch (error) {
      this.options.logger.warn('stripe checkout session not expired', stripeErrorFields(error));
      throw PaymentErrors.providerUnavailable();
    }
    if (status === 'expired') return 'CLOSED';
    if (status === 'complete') return 'COMPLETED';
    throw PaymentErrors.providerUnavailable();
  }

  verifyWebhook(request: ProviderWebhookRequest, nowMs: number): Buffer {
    const type = (request.contentType ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') throw PaymentErrors.webhookInvalid(415);
    const raw = request.rawBody;
    if (!raw || raw.length === 0) throw PaymentErrors.webhookInvalid(400);
    if (raw.length > STRIPE_MAX_PAYLOAD_BYTES) throw PaymentErrors.webhookInvalid(413);

    const header = request.header(STRIPE_SIGNATURE_HEADER) ?? '';
    if (header.length === 0 || header.length > MAX_SIGNATURE_HEADER_LENGTH) {
      throw PaymentErrors.webhookInvalid(401);
    }
    // The SDK refuses old timestamps; a timestamp from the future is refused too.
    const timestamp = /^t=(\d{1,12}),/.exec(header)?.[1];
    if (!timestamp || Number(timestamp) > nowMs / 1000 + STRIPE_SIGNATURE_TOLERANCE_SECONDS) {
      throw PaymentErrors.webhookInvalid(401);
    }
    try {
      // Official verification: HMAC-SHA256 of "<t>.<raw body>", constant-time
      // comparison, tolerance. Its error carries the header and the payload:
      // it is never logged.
      Stripe.webhooks.constructEvent(
        raw,
        header,
        this.options.webhookSecret,
        STRIPE_SIGNATURE_TOLERANCE_SECONDS,
        undefined,
        nowMs,
      );
    } catch {
      throw PaymentErrors.webhookInvalid(401);
    }
    return raw;
  }

  parseWebhook(rawBody: Buffer): ProviderEvent | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw PaymentErrors.webhookInvalid(400);
    }
    const event = eventSchema.safeParse(decoded);
    if (!event.success) throw PaymentErrors.webhookInvalid(400);
    if (event.data.livemode !== !this.testMode) throw PaymentErrors.webhookInvalid(400);
    if (!RESULT_EVENTS.has(event.data.type)) return null;

    const session = sessionSchema.safeParse(event.data.data.object);
    if (!session.success || session.data.livemode !== event.data.livemode) {
      throw PaymentErrors.webhookInvalid(400);
    }
    const reference = session.data.metadata?.[STRIPE_METADATA_KEY];
    // Not one of our sessions (another integration of the same account).
    if (
      !reference ||
      !PAYMENT_REFERENCE_PATTERN.test(reference) ||
      session.data.client_reference_id !== reference
    ) {
      return null;
    }

    const paid = session.data.payment_status === 'paid';
    let result: Pick<ProviderEvent, 'type' | 'failureCode'> | null = null;
    switch (event.data.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        // A completed session that is not paid yet is a delayed payment:
        // its own success or failure event follows.
        result = paid ? { type: 'PAYMENT_SUCCEEDED', failureCode: null } : null;
        break;
      case 'checkout.session.async_payment_failed':
        result = { type: 'PAYMENT_FAILED', failureCode: 'UNKNOWN' };
        break;
      case 'checkout.session.expired':
        result = { type: 'PAYMENT_FAILED', failureCode: 'CHECKOUT_EXPIRED' };
        break;
    }
    if (!result) return null;
    return {
      providerEventId: event.data.id,
      ...result,
      providerPaymentId: session.data.id,
      amountMinor: BigInt(session.data.amount_total),
      currencyCode: session.data.currency.toUpperCase(),
      payloadHash: createHash('sha256').update(rawBody).digest('hex'),
    };
  }
}
