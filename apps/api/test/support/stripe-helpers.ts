import { createHash, randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import type {
  StripeGateway,
  StripeSessionSummary,
} from '../../src/payments/providers/stripe-payment.provider.js';

/**
 * PAY-EU-1 test support: a fake of the Stripe API calls (CI never reaches
 * Stripe), synthetic Stripe-shaped secrets generated at run time, and events
 * signed with the official SDK's own test helper.
 */

/** Synthetic test-mode values: never a real key. */
export const syntheticStripeSecretKey = () => `sk_${'test'}_${randomBytes(24).toString('hex')}`;
export const syntheticStripeWebhookSecret = () => `whsec_${randomBytes(24).toString('hex')}`;

type CreateParams = Stripe.Checkout.SessionCreateParams;

export interface FakeSessionCall {
  params: CreateParams;
  idempotencyKey: string;
}

/**
 * Behaves like Stripe for what the adapter uses: one session per idempotency
 * key (a replay returns the same session), the requested amount echoed back,
 * and expiry of an open session.
 */
export class FakeStripeGateway implements StripeGateway {
  readonly calls: FakeSessionCall[] = [];
  readonly expireCalls: string[] = [];
  /** Status a session has after an expiry request (`complete` when already paid). */
  statusAfterExpire: string = 'expired';
  /** Next create or expire call fails with this error. */
  failNext: Error | null = null;
  /** Fields of the returned session to override (a misbehaving provider). */
  override: Partial<StripeSessionSummary> = {};
  /** Optional hook, e.g. to observe the database during the network call. */
  onCreate: (() => Promise<void>) | null = null;
  livemode = false;

  static sessionIdFor(idempotencyKey: string): string {
    const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24);
    return `cs_test_${digest}`;
  }

  async createCheckoutSession(
    params: CreateParams,
    idempotencyKey: string,
  ): Promise<StripeSessionSummary> {
    this.calls.push({ params: structuredClone(params), idempotencyKey });
    if (this.onCreate) await this.onCreate();
    const failure = this.failNext;
    this.failNext = null;
    if (failure) throw failure;
    const id = FakeStripeGateway.sessionIdFor(idempotencyKey);
    return {
      id,
      url: `https://checkout.stripe.com/c/pay/${id}`,
      amountTotal: params.line_items?.[0]?.price_data?.unit_amount ?? null,
      currency: params.line_items?.[0]?.price_data?.currency ?? null,
      livemode: this.livemode,
      ...this.override,
    };
  }

  expireCheckoutSession(sessionId: string): Promise<string> {
    this.expireCalls.push(sessionId);
    const failure = this.failNext;
    this.failNext = null;
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.statusAfterExpire);
  }
}

/** A Stripe SDK error, as the SDK raises it (no network involved). */
export function stripeApiError(): Error {
  return new Stripe.errors.StripeInvalidRequestError({
    type: 'invalid_request_error',
    message: 'synthetic test error',
    code: 'payment_method_unavailable',
  });
}

export interface SessionEventInput {
  type?: string;
  eventId?: string;
  sessionId: string;
  paymentReference: string;
  amountTotal: number;
  currency?: string;
  paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required';
  livemode?: boolean;
  /** Overrides of the session object (e.g. foreign metadata). */
  session?: Record<string, unknown>;
}

let eventCounter = 0;
/** A fresh, well-formed Stripe event id. */
export const stripeEventId = () =>
  `evt_test${String(++eventCounter).padStart(4, '0')}${randomBytes(8).toString('hex')}`;

/**
 * A snapshot `checkout.session.*` event shaped like Stripe's (API version
 * 2026-09-30.endive), with the fields the adapter does not read as well.
 */
export function checkoutSessionEvent(input: SessionEventInput): string {
  const livemode = input.livemode ?? false;
  const session = {
    id: input.sessionId,
    object: 'checkout.session',
    allowed_payment_method_types: ['card'],
    amount_subtotal: input.amountTotal,
    amount_total: input.amountTotal,
    client_reference_id: input.paymentReference,
    created: 1_790_000_000,
    currency: input.currency ?? 'eur',
    customer: null,
    customer_details: null,
    expires_at: 1_790_001_860,
    livemode,
    metadata: { euroteranga_payment_reference: input.paymentReference },
    mode: 'payment',
    payment_intent: 'pi_test_synthetic0000000000',
    payment_method_types: ['card'],
    payment_status: input.paymentStatus ?? 'paid',
    status: input.type === 'checkout.session.expired' ? 'expired' : 'complete',
    success_url: 'http://localhost:3002/compte?paiement=retour',
    url: null,
    ...input.session,
  };
  return JSON.stringify({
    id: input.eventId ?? stripeEventId(),
    object: 'event',
    api_version: '2026-09-30.endive',
    created: 1_790_000_100,
    data: { object: session },
    livemode,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: input.type ?? 'checkout.session.completed',
  });
}

/** The Stripe-Signature header of a payload, computed by the official SDK. */
export function stripeSignature(payload: string, secret: string, timestampSeconds?: number) {
  return Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    ...(timestampSeconds === undefined ? {} : { timestamp: timestampSeconds }),
  });
}
