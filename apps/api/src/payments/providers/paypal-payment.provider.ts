import { createHash } from 'node:crypto';
import type { Logger } from '@euroteranga/logger';
import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  PayeePaymentMethodPreference,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type OrderRequest,
} from '@paypal/paypal-server-sdk';
import { z } from 'zod';
import { PublicApiError } from '../../auth/http/public-api-error.js';
import { declaredCapability } from '../payment-capability.registry.js';
import { PaymentErrors } from '../payment.errors.js';
import type {
  PaymentProvider,
  ProviderApproval,
  ProviderCaptureResult,
  ProviderCheckout,
  ProviderEvent,
  ProviderPaymentRequest,
  ProviderWebhookRequest,
} from './payment-provider.js';

/** Largest accepted webhook payload (the API's JSON body limit). */
export const PAYPAL_MAX_PAYLOAD_BYTES = 32 * 1024;
/** Time limit of each PayPal API call (the SDK default is none). */
export const PAYPAL_TIMEOUT_MS = 10_000;

/** PayPal's hosted approval page, per mode: the only redirect we accept. */
export const PAYPAL_APPROVAL_HOSTS = {
  SANDBOX: 'www.sandbox.paypal.com',
  LIVE: 'www.paypal.com',
} as const;

/** Orders v2: order ids are `^[A-Z0-9]+$`, 36 characters at most. */
const ORDER_ID = /^[A-Z0-9]{1,36}$/;
/** Webhook event ids, e.g. `WH-152442318H6474839-1HN0997948621344U`. */
const EVENT_ID = /^WH-[A-Z0-9-]{8,100}$/;
/** EUR values as PayPal writes them: two decimals, up to 15 integer digits. */
const EUR_VALUE = /^(0|[1-9][0-9]{0,14})\.([0-9]{2})$/;

/**
 * Transmission headers of a PayPal webhook, bounded as the Webhooks API's
 * verify-webhook-signature request bounds them.
 */
const TRANSMISSION_HEADERS = {
  auth_algo: { header: 'paypal-auth-algo', pattern: /^[a-zA-Z0-9]{1,100}$/ },
  cert_url: { header: 'paypal-cert-url', pattern: /^https:\/\/[^\s]{1,492}$/ },
  transmission_id: { header: 'paypal-transmission-id', pattern: /^(?!\d+$)\w\S{1,49}$/ },
  transmission_sig: { header: 'paypal-transmission-sig', pattern: /^(?!\d+$)\w\S{1,499}$/ },
  transmission_time: {
    header: 'paypal-transmission-time',
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
  },
} as const;

/** An exact EUR amount in minor units -> PayPal's decimal string ("249.00"), no float. */
export function eurMinorToValue(amountMinor: bigint): string {
  if (amountMinor <= 0n) throw new Error('a PayPal amount must be positive');
  const units = amountMinor / 100n;
  const cents = amountMinor % 100n;
  return `${units}.${cents.toString().padStart(2, '0')}`;
}

/** A two-decimal string ("249.00") -> exact minor units (24900); null otherwise. */
export function eurValueToMinor(value: string): bigint | null {
  const match = EUR_VALUE.exec(value);
  return match ? BigInt(match[1]!) * 100n + BigInt(match[2]!) : null;
}

/** What the adapter reads of an order; never stored, never logged. */
export interface PayPalOrderSummary {
  id: string;
  status: string | null;
  links: ReadonlyArray<{ rel: string; href: string }>;
}

/** A PayPal API refusal, reduced to what is safe to keep (no request, no token). */
export class PayPalRequestError extends Error {
  constructor(
    readonly statusCode: number | null,
    readonly issue: string | null,
    readonly debugId: string | null,
  ) {
    super('PayPal request failed');
  }
}

/**
 * The PayPal API calls of the adapter, behind one seam: production uses the
 * official Server SDK (PayPalSdkGateway); tests use a fake, so CI never
 * reaches PayPal.
 */
export interface PayPalGateway {
  createOrder(body: OrderRequest, requestId: string): Promise<PayPalOrderSummary>;
  /** Resolves with the capture's status when PayPal answers; throws PayPalRequestError otherwise. */
  captureOrder(orderId: string, requestId: string): Promise<{ status: string | null }>;
  /** PayPal's verify-webhook-signature answer (`SUCCESS` or `FAILURE`). */
  verifyWebhookSignature(body: string): Promise<string>;
}

function requestError(error: unknown): PayPalRequestError {
  if (error instanceof PayPalRequestError) return error;
  if (error instanceof ApiError) {
    const result = (error.result ?? {}) as {
      name?: unknown;
      debug_id?: unknown;
      details?: Array<{ issue?: unknown }>;
    };
    const issue = result.details?.[0]?.issue ?? result.name;
    return new PayPalRequestError(
      error.statusCode,
      typeof issue === 'string' ? issue.slice(0, 64) : null,
      typeof result.debug_id === 'string' ? result.debug_id.slice(0, 64) : null,
    );
  }
  // A timeout or a network failure: the outcome at PayPal is unknown.
  return new PayPalRequestError(null, null, null);
}

/**
 * The official PayPal Server SDK (`@paypal/paypal-server-sdk`). The SDK has
 * no webhook controller, so the verify-webhook-signature call goes through
 * the SDK's own request builder: same OAuth 2.0 client credentials, same
 * transport, same base URL (from our mode, never from the webhook).
 */
export class PayPalSdkGateway implements PayPalGateway {
  private readonly client: Client;
  private readonly orders: OrdersController;

  constructor(mode: 'SANDBOX' | 'LIVE', clientId: string, clientSecret: string) {
    this.client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: clientId,
        oAuthClientSecret: clientSecret,
      },
      environment: mode === 'LIVE' ? Environment.Production : Environment.Sandbox,
      timeout: PAYPAL_TIMEOUT_MS,
    });
    this.orders = new OrdersController(this.client);
  }

  async createOrder(body: OrderRequest, requestId: string): Promise<PayPalOrderSummary> {
    try {
      const { result } = await this.orders.createOrder({
        body,
        paypalRequestId: requestId,
        prefer: 'return=minimal',
      });
      return {
        id: result.id ?? '',
        status: result.status ?? null,
        links: (result.links ?? []).map((link) => ({ rel: link.rel, href: link.href })),
      };
    } catch (error) {
      throw requestError(error);
    }
  }

  async captureOrder(orderId: string, requestId: string): Promise<{ status: string | null }> {
    try {
      const { result } = await this.orders.captureOrder({
        id: orderId,
        paypalRequestId: requestId,
        prefer: 'return=minimal',
      });
      return { status: result.status ?? null };
    } catch (error) {
      throw requestError(error);
    }
  }

  async verifyWebhookSignature(body: string): Promise<string> {
    try {
      const request = this.client.getRequestBuilderFactory()(
        'POST',
        '/v1/notifications/verify-webhook-signature',
      );
      request.header('Content-Type', 'application/json');
      request.text(body);
      request.authenticate([{ oauth2: true }]);
      const { result } = await request.callAsText();
      const parsed = z
        .object({ verification_status: z.string().max(16) })
        .safeParse(JSON.parse(result));
      return parsed.success ? parsed.data.verification_status : 'FAILURE';
    } catch (error) {
      throw requestError(error);
    }
  }
}

export interface PayPalProviderOptions {
  mode: 'SANDBOX' | 'LIVE';
  /** The webhook's ID, from our configuration only. */
  webhookId: string;
  /** Where PayPal sends the customer back (the client area); confirms nothing. */
  returnUrl: string;
  gateway: PayPalGateway;
  logger: Logger;
}

const money = z.object({
  currency_code: z.string().regex(/^[A-Z]{3}$/),
  value: z.string().max(32),
});

const eventSchema = z.object({
  id: z.string().regex(EVENT_ID),
  event_type: z.string().min(1).max(100),
  resource: z.record(z.string(), z.unknown()),
});

/** CHECKOUT.ORDER.APPROVED: the resource is the order (Orders v2). */
const approvedOrderSchema = z.object({
  id: z.string().regex(ORDER_ID),
  status: z.string().max(32).optional(),
  intent: z.string().max(32).optional(),
  purchase_units: z
    .array(z.object({ amount: money.optional() }))
    .max(10)
    .optional(),
});

/** CHECKOUT.PAYMENT-APPROVAL.REVERSED: the order id is `resource.order_id`. */
const reversedSchema = z.object({ order_id: z.string().regex(ORDER_ID) });

/** PAYMENT.CAPTURE.*: the resource is a capture (Payments v2 `capture-2`). */
const captureSchema = z.object({
  id: z.string().regex(/^[A-Z0-9]{1,36}$/),
  status: z.string().max(32),
  amount: money,
  supplementary_data: z.object({
    related_ids: z.object({ order_id: z.string().regex(ORDER_ID) }),
  }),
});

const CAPTURE_FAILURE_EVENTS = new Set(['PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED']);

/**
 * A PayPal money object, read exactly: a two-decimal value in minor units.
 * Another currency is read the same way so it can be refused as a currency
 * mismatch; a value that is not exactly two decimals is malformed.
 */
function readAmount(value: z.infer<typeof money>): { amountMinor: bigint; currencyCode: string } {
  const amountMinor = eurValueToMinor(value.value);
  if (amountMinor === null) throw PaymentErrors.webhookInvalid(400);
  return { amountMinor, currencyCode: value.currency_code };
}

/** A failed PayPal call, as logged: status, issue and debug id only. */
function errorFields(error: PayPalRequestError) {
  return {
    paypalStatusCode: error.statusCode,
    paypalIssue: error.issue,
    paypalDebugId: error.debugId,
  };
}

/**
 * PayPal Wallet (PAY-PAYPAL-1): Orders API v2 with intent CAPTURE, payers in
 * France and Spain, EUR only. The customer approves on PayPal's page; the
 * approval takes no money. EURO TERANGA captures only while the attempt and
 * its hold are still payable, and only the capture's own signed event
 * (PAYMENT.CAPTURE.COMPLETED) succeeds the attempt. Disabled by default
 * (PAYMENT_PAYPAL_MODE).
 */
export class PayPalPaymentProvider implements PaymentProvider {
  readonly name = 'PAYPAL' as const;
  readonly testMode: boolean;
  readonly capability = declaredCapability('PAYPAL');

  constructor(private readonly options: PayPalProviderOptions) {
    this.testMode = options.mode === 'SANDBOX';
  }

  async createPayment(request: ProviderPaymentRequest): Promise<ProviderCheckout> {
    if (request.paymentMethod !== 'PAYPAL') throw PaymentErrors.methodUnavailable();
    if (request.payerCountry !== 'FR' && request.payerCountry !== 'ES') {
      throw PaymentErrors.countryUnsupported();
    }
    if (request.presentmentCurrencyCode !== 'EUR' || request.presentmentCurrencyMinorUnit !== 2) {
      throw PaymentErrors.currencyUnsupported();
    }
    const value = eurMinorToValue(request.presentmentAmountMinor);
    const body: OrderRequest = {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [
        {
          amount: { currencyCode: 'EUR', value },
          // Our payment reference, for reconciliation; never shown to the payer.
          customId: request.paymentReference,
          description: `Réservation ${request.bookingReference}`,
        },
      ],
      paymentSource: {
        paypal: {
          experienceContext: {
            returnUrl: `${this.options.returnUrl}?paiement=retour`,
            cancelUrl: `${this.options.returnUrl}?paiement=abandon`,
            // A passenger ticket ships nothing: no address is asked for.
            shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
            userAction: PaypalExperienceUserAction.PayNow,
            paymentMethodPreference: PayeePaymentMethodPreference.ImmediatePaymentRequired,
          },
        },
      },
    };

    let order: PayPalOrderSummary;
    try {
      // The payment reference is the PayPal-Request-Id: a replay gets the same order.
      order = await this.options.gateway.createOrder(body, request.paymentReference);
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      this.options.logger.warn('paypal order not created', {
        paymentReference: request.paymentReference,
        ...errorFields(requestError(error)),
      });
      throw PaymentErrors.providerUnavailable();
    }
    const approval = ORDER_ID.test(order.id) ? this.approvalUrl(order) : null;
    if (!approval) {
      this.options.logger.warn('paypal order refused', {
        paymentReference: request.paymentReference,
      });
      throw PaymentErrors.providerUnavailable();
    }
    return { providerPaymentId: order.id, redirectUrl: approval };
  }

  /**
   * The order's `payer-action` link (returned when the order carries
   * `payment_source.paypal`), only when it is PayPal's own approval page for
   * this mode and this very order. Anything else is refused.
   */
  private approvalUrl(order: PayPalOrderSummary): string | null {
    const links = order.links.filter((link) => link.rel === 'payer-action');
    if (links.length !== 1) return null;
    let url: URL;
    try {
      url = new URL(links[0]!.href);
    } catch {
      return null;
    }
    const valid =
      url.protocol === 'https:' &&
      url.hostname === PAYPAL_APPROVAL_HOSTS[this.options.mode] &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/checkoutnow' &&
      url.hash === '' &&
      [...url.searchParams.keys()].join(',') === 'token' &&
      url.searchParams.get('token') === order.id;
    return valid ? url.toString() : null;
  }

  async capturePayment(
    providerPaymentId: string,
    idempotencyKey: string,
  ): Promise<ProviderCaptureResult> {
    if (!ORDER_ID.test(providerPaymentId)) throw PaymentErrors.notFound();
    try {
      await this.options.gateway.captureOrder(providerPaymentId, idempotencyKey);
      // Whatever its status, only the capture's own event decides.
      return 'CAPTURE_REQUESTED';
    } catch (error) {
      const failure = requestError(error);
      if (failure.statusCode === 422 && failure.issue === 'ORDER_ALREADY_CAPTURED') {
        return 'ALREADY_CAPTURED';
      }
      this.options.logger.warn('paypal capture not confirmed', errorFields(failure));
      // A refusal PayPal states (e.g. INSTRUMENT_DECLINED, ORDER_NOT_APPROVED):
      // nothing was captured. Anything else (timeout, 5xx): unknown outcome,
      // the approval is redelivered and the same capture retried.
      if (failure.statusCode === 422 || failure.statusCode === 404) return 'NOT_CAPTURABLE';
      throw PaymentErrors.providerUnavailable();
    }
  }

  async verifyWebhook(request: ProviderWebhookRequest, _nowMs: number): Promise<Buffer> {
    const type = (request.contentType ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') throw PaymentErrors.webhookInvalid(415);
    const raw = request.rawBody;
    if (!raw || raw.length === 0) throw PaymentErrors.webhookInvalid(400);
    if (raw.length > PAYPAL_MAX_PAYLOAD_BYTES) throw PaymentErrors.webhookInvalid(413);

    const transmission: Record<string, string> = {};
    for (const [field, { header, pattern }] of Object.entries(TRANSMISSION_HEADERS)) {
      const value = request.header(header) ?? '';
      if (!pattern.test(value)) throw PaymentErrors.webhookInvalid(401);
      transmission[field] = value;
    }
    // The event goes back to PayPal byte for byte, so it must be one JSON object.
    const text = raw.toString('utf8');
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw PaymentErrors.webhookInvalid(400);
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw PaymentErrors.webhookInvalid(400);
    }
    // PayPal checks the signature (and its certificate) itself; we never
    // fetch PAYPAL-CERT-URL. webhook_event is the raw body, unchanged.
    const head = JSON.stringify({ ...transmission, webhook_id: this.options.webhookId });
    const body = `${head.slice(0, -1)},"webhook_event":${text}}`;
    let status: string;
    try {
      status = await this.options.gateway.verifyWebhookSignature(body);
    } catch (error) {
      this.options.logger.warn('paypal webhook verification unavailable', {
        ...errorFields(requestError(error)),
      });
      throw PaymentErrors.providerUnavailable();
    }
    if (status !== 'SUCCESS') throw PaymentErrors.webhookInvalid(401);
    return raw;
  }

  parseWebhook(rawBody: Buffer): ProviderEvent | ProviderApproval | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw PaymentErrors.webhookInvalid(400);
    }
    const event = eventSchema.safeParse(decoded);
    if (!event.success) throw PaymentErrors.webhookInvalid(400);
    const { id, event_type: type, resource } = event.data;
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');

    switch (type) {
      case 'CHECKOUT.ORDER.APPROVED': {
        const order = approvedOrderSchema.safeParse(resource);
        if (!order.success) throw PaymentErrors.webhookInvalid(400);
        // We only create CAPTURE orders: anything else is not ours.
        if (order.data.intent !== undefined && order.data.intent !== 'CAPTURE') return null;
        const units = order.data.purchase_units ?? [];
        if (units.length > 1) throw PaymentErrors.webhookInvalid(400);
        const amount = units[0]?.amount ? readAmount(units[0].amount) : null;
        return {
          type: 'PAYMENT_APPROVED',
          providerEventId: id,
          providerPaymentId: order.data.id,
          amountMinor: amount?.amountMinor ?? null,
          currencyCode: amount?.currencyCode ?? null,
          payloadHash,
        };
      }
      case 'CHECKOUT.PAYMENT-APPROVAL.REVERSED': {
        const reversed = reversedSchema.safeParse(resource);
        if (!reversed.success) throw PaymentErrors.webhookInvalid(400);
        // Not captured in time: PayPal cancels the order; no money moved.
        return {
          type: 'PAYMENT_FAILED',
          providerEventId: id,
          providerPaymentId: reversed.data.order_id,
          amountMinor: null,
          currencyCode: null,
          failureCode: 'CHECKOUT_EXPIRED',
          payloadHash,
        };
      }
      case 'PAYMENT.CAPTURE.COMPLETED':
      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.CAPTURE.DECLINED': {
        const capture = captureSchema.safeParse(resource);
        if (!capture.success) throw PaymentErrors.webhookInvalid(400);
        const { status, supplementary_data: data } = capture.data;
        const { amountMinor, currencyCode } = readAmount(capture.data.amount);
        if (type === 'PAYMENT.CAPTURE.COMPLETED') {
          if (status !== 'COMPLETED') throw PaymentErrors.webhookInvalid(400);
          return {
            type: 'PAYMENT_SUCCEEDED',
            providerEventId: id,
            providerPaymentId: data.related_ids.order_id,
            amountMinor,
            currencyCode,
            failureCode: null,
            payloadHash,
          };
        }
        if (!CAPTURE_FAILURE_EVENTS.has(type)) return null;
        return {
          type: 'PAYMENT_FAILED',
          providerEventId: id,
          providerPaymentId: data.related_ids.order_id,
          amountMinor,
          currencyCode,
          failureCode: 'DECLINED',
          payloadHash,
        };
      }
      default:
        // PAYMENT.CAPTURE.PENDING (still PENDING: wait), refunds, reversals and
        // anything else: acknowledged, no change.
        return null;
    }
  }
}
