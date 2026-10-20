import { createHash, randomBytes } from 'node:crypto';
import type { OrderRequest } from '@paypal/paypal-server-sdk';
import {
  PayPalRequestError,
  type PayPalGateway,
  type PayPalOrderSummary,
} from '../../src/payments/providers/paypal-payment.provider.js';

/**
 * PAY-PAYPAL-1 test support: a fake of the PayPal API calls (CI never reaches
 * PayPal), synthetic credentials generated at run time, and webhook events
 * shaped on the official samples of the Orders v2 and Payments v2 references.
 */

export const syntheticPayPalClientId = () => randomBytes(36).toString('base64url');
export const syntheticPayPalClientSecret = () => randomBytes(36).toString('base64url');
export const syntheticPayPalWebhookId = () => randomBytes(9).toString('hex').toUpperCase();

/** A PayPal-shaped order id, derived from the creation key (as PayPal's idempotency would). */
export const orderIdFor = (requestId: string) =>
  createHash('sha256').update(requestId).digest('hex').slice(0, 17).toUpperCase();

interface FakeOrder {
  id: string;
  capturedWith: string | null;
}

/**
 * Behaves like PayPal for what the adapter uses: one order per
 * PayPal-Request-Id; a capture with the same key returns the same capture;
 * another key on a captured order is refused (ORDER_ALREADY_CAPTURED).
 */
export class FakePayPalGateway implements PayPalGateway {
  readonly orders = new Map<string, FakeOrder>();
  readonly createCalls: Array<{ body: OrderRequest; requestId: string }> = [];
  readonly captureCalls: Array<{ orderId: string; requestId: string }> = [];
  readonly verifyCalls: string[] = [];
  /** Number of distinct captures (money moved) per order. */
  readonly captures = new Map<string, number>();
  host = 'www.sandbox.paypal.com';
  /** Override of the links of the next created order (a misbehaving provider). */
  links: Array<{ rel: string; href: string }> | null = null;
  verification: string = 'SUCCESS';
  /** Next create, capture or verify call fails with this error. */
  failNext: Error | null = null;
  onCreate: (() => Promise<void>) | null = null;
  onCapture: (() => Promise<void>) | null = null;

  private takeFailure() {
    const failure = this.failNext;
    this.failNext = null;
    return failure;
  }

  async createOrder(body: OrderRequest, requestId: string): Promise<PayPalOrderSummary> {
    this.createCalls.push({ body: structuredClone(body), requestId });
    if (this.onCreate) await this.onCreate();
    const failure = this.takeFailure();
    if (failure) throw failure;
    const id = orderIdFor(requestId);
    if (!this.orders.has(id)) this.orders.set(id, { id, capturedWith: null });
    const links = this.links ?? [
      { rel: 'self', href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}` },
      { rel: 'payer-action', href: `https://${this.host}/checkoutnow?token=${id}` },
    ];
    this.links = null;
    return { id, status: 'PAYER_ACTION_REQUIRED', links };
  }

  async captureOrder(orderId: string, requestId: string): Promise<{ status: string | null }> {
    this.captureCalls.push({ orderId, requestId });
    if (this.onCapture) await this.onCapture();
    const failure = this.takeFailure();
    if (failure) throw failure;
    const order = this.orders.get(orderId);
    if (!order) throw new PayPalRequestError(404, 'RESOURCE_NOT_FOUND', 'dbg-synthetic');
    if (order.capturedWith === null) {
      order.capturedWith = requestId;
      this.captures.set(orderId, 1);
    } else if (order.capturedWith !== requestId) {
      throw new PayPalRequestError(422, 'ORDER_ALREADY_CAPTURED', 'dbg-synthetic');
    }
    return { status: 'COMPLETED' };
  }

  async verifyWebhookSignature(body: string): Promise<string> {
    this.verifyCalls.push(body);
    const failure = this.takeFailure();
    if (failure) throw failure;
    return this.verification;
  }
}

/** Transmission headers PayPal sends with each webhook (values synthetic). */
export function paypalTransmissionHeaders(overrides: Record<string, string> = {}) {
  return {
    'PAYPAL-AUTH-ALGO': 'SHA256withRSA',
    'PAYPAL-CERT-URL':
      'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270',
    'PAYPAL-TRANSMISSION-ID': `${randomBytes(4).toString('hex')}-${randomBytes(2).toString('hex')}-11ef-a4f4-${randomBytes(6).toString('hex')}`,
    // Starts with a word character, as the Webhooks API requires.
    'PAYPAL-TRANSMISSION-SIG': `s${randomBytes(96).toString('base64')}`,
    'PAYPAL-TRANSMISSION-TIME': new Date().toISOString(),
    ...overrides,
  };
}

let counter = 0;
/** A fresh, well-formed webhook event id (`WH-...`). */
export const paypalEventId = () =>
  `WH-${String(++counter).padStart(4, '0')}${randomBytes(6).toString('hex').toUpperCase()}-${randomBytes(8).toString('hex').toUpperCase()}`;

const links = (path: string) => [
  { href: `https://api-m.sandbox.paypal.com${path}`, rel: 'self', method: 'GET' },
];

/** CHECKOUT.ORDER.APPROVED: the resource is the approved order (Orders v2). */
export function orderApprovedEvent(input: {
  orderId: string;
  eventId?: string;
  amount?: { value: string; currency_code: string } | null;
  intent?: string;
}) {
  return JSON.stringify({
    id: input.eventId ?? paypalEventId(),
    event_version: '1.0',
    create_time: '2026-10-20T10:00:00.000Z',
    resource_type: 'checkout-order',
    resource_version: '2.0',
    event_type: 'CHECKOUT.ORDER.APPROVED',
    summary: 'An order has been approved by buyer',
    resource: {
      id: input.orderId,
      intent: input.intent ?? 'CAPTURE',
      status: 'APPROVED',
      ...(input.amount === null
        ? {}
        : {
            purchase_units: [
              {
                reference_id: 'default',
                amount: input.amount ?? { currency_code: 'EUR', value: '249.00' },
              },
            ],
          }),
      create_time: '2026-10-20T09:58:00Z',
      links: links(`/v2/checkout/orders/${input.orderId}`),
    },
    links: links('/v1/notifications/webhooks-events/WH-SYNTHETIC'),
  });
}

/** CHECKOUT.PAYMENT-APPROVAL.REVERSED (official sample: `resource.order_id`). */
export function approvalReversedEvent(input: { orderId: string; eventId?: string }) {
  return JSON.stringify({
    id: input.eventId ?? paypalEventId(),
    create_time: '2026-10-20T13:00:00.000Z',
    event_type: 'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
    summary: 'A payment has been reversed after approval.',
    resource: {
      order_id: input.orderId,
      purchase_units: [{ reference_id: 'default' }],
    },
    event_version: '1.0',
  });
}

/** PAYMENT.CAPTURE.* (official samples: capture-2 with `supplementary_data.related_ids.order_id`). */
export function captureEvent(input: {
  type:
    | 'PAYMENT.CAPTURE.COMPLETED'
    | 'PAYMENT.CAPTURE.PENDING'
    | 'PAYMENT.CAPTURE.DENIED'
    | 'PAYMENT.CAPTURE.DECLINED'
    | 'PAYMENT.CAPTURE.REFUNDED';
  orderId: string;
  eventId?: string;
  value?: string;
  currency?: string;
  status?: string;
  relatedIds?: Record<string, string> | null;
}) {
  const status =
    input.status ??
    {
      'PAYMENT.CAPTURE.COMPLETED': 'COMPLETED',
      'PAYMENT.CAPTURE.PENDING': 'PENDING',
      'PAYMENT.CAPTURE.DENIED': 'DECLINED',
      'PAYMENT.CAPTURE.DECLINED': 'DECLINED',
      'PAYMENT.CAPTURE.REFUNDED': 'REFUNDED',
    }[input.type];
  const captureId = `${input.orderId.slice(0, 8)}CAPT${randomBytes(3).toString('hex').toUpperCase()}`;
  return JSON.stringify({
    id: input.eventId ?? paypalEventId(),
    event_version: '1.0',
    create_time: '2026-10-20T10:01:00.000Z',
    resource_type: 'capture',
    resource_version: '2.0',
    event_type: input.type,
    summary: `Payment ${status.toLowerCase()} for 249.00 EUR`,
    resource: {
      id: captureId,
      status,
      ...(status === 'PENDING' ? { status_details: { reason: 'PENDING_REVIEW' } } : {}),
      amount: { currency_code: input.currency ?? 'EUR', value: input.value ?? '249.00' },
      final_capture: true,
      seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED'] },
      seller_receivable_breakdown: {
        gross_amount: { currency_code: 'EUR', value: input.value ?? '249.00' },
        paypal_fee: { currency_code: 'EUR', value: '8.72' },
        net_amount: { currency_code: 'EUR', value: '240.28' },
      },
      ...(input.relatedIds === null
        ? {}
        : { supplementary_data: { related_ids: input.relatedIds ?? { order_id: input.orderId } } }),
      create_time: '2026-10-20T10:00:59Z',
      update_time: '2026-10-20T10:00:59Z',
      links: [
        ...links(`/v2/payments/captures/${captureId}`),
        {
          href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${input.orderId}`,
          rel: 'up',
          method: 'GET',
        },
      ],
    },
    links: links('/v1/notifications/webhooks-events/WH-SYNTHETIC'),
  });
}
