import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { declaredCapability } from '../payment-capability.registry.js';
import { PaymentErrors } from '../payment.errors.js';
import type { PaymentFailureCode } from '../payment-rules.js';
import type {
  PaymentProvider,
  ProviderCheckout,
  ProviderEvent,
  ProviderPaymentRequest,
  ProviderWebhookRequest,
} from './payment-provider.js';

/** Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. */
export const SANDBOX_SIGNATURE_HEADER = 'et-sandbox-signature';
/** Accepted clock difference between the signature and the server. */
export const SANDBOX_SIGNATURE_TOLERANCE_SECONDS = 300;
/** Largest accepted webhook payload. */
export const SANDBOX_MAX_PAYLOAD_BYTES = 8 * 1024;

const SIGNATURE_PATTERN = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

/** Signature of a SANDBOX payload (shared by the provider and test harnesses). */
export function signSandboxPayload(key: Buffer, timestamp: number, rawBody: string | Buffer) {
  const digest = createHmac('sha256', key).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/** SANDBOX failure vocabulary mapped onto normalized codes (anything else: UNKNOWN). */
const SANDBOX_FAILURES = new Map<string, PaymentFailureCode>([
  ['declined', 'DECLINED'],
  ['insufficient_funds', 'INSUFFICIENT_FUNDS'],
  ['authentication_failed', 'AUTHENTICATION_FAILED'],
  ['checkout_expired', 'CHECKOUT_EXPIRED'],
  ['provider_error', 'PROVIDER_ERROR'],
]);

const payloadSchema = z
  .object({
    id: z.string().regex(/^evt_[A-Za-z0-9_]{8,100}$/),
    type: z.enum(['payment.succeeded', 'payment.failed']),
    data: z
      .object({
        providerPaymentId: z.string().regex(/^sbx_[A-Za-z0-9_-]{8,100}$/),
        amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        currency: z.string().regex(/^[A-Z]{3}$/),
        failureReason: z.string().max(64).optional(),
      })
      .strict(),
  })
  .strict()
  .refine((event) => event.type === 'payment.failed' || event.data.failureReason === undefined, {
    message: 'only a failure carries a reason',
  });

/**
 * Local, test-only provider (dev, test, CI). It contacts no external service
 * and moves no money: an attempt only gets an opaque id, and its result
 * arrives later as a signed SANDBOX event, through the same webhook pipeline
 * as a real provider's. The configuration refuses it in staging and
 * production.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'SANDBOX' as const;
  readonly testMode = true;
  /** Every method, country and currency of the catalogue, in local and CI only. */
  readonly capability = declaredCapability('SANDBOX');

  constructor(private readonly webhookKey: Buffer) {}

  createPayment(request: ProviderPaymentRequest): Promise<ProviderCheckout> {
    // SANDBOX models the provider contract without keeping process-local
    // state: the stable provider id is derived only from the idempotency key.
    const stableId = createHash('sha256')
      .update(request.paymentReference)
      .digest('base64url')
      .slice(0, 24);
    return Promise.resolve({
      providerPaymentId: `sbx_${stableId}`,
      redirectUrl: null,
    });
  }

  verifyWebhook(request: ProviderWebhookRequest, nowMs: number): Buffer {
    const type = (request.contentType ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') throw PaymentErrors.webhookInvalid(415);
    const raw = request.rawBody;
    if (!raw || raw.length === 0) throw PaymentErrors.webhookInvalid(400);
    if (raw.length > SANDBOX_MAX_PAYLOAD_BYTES) throw PaymentErrors.webhookInvalid(413);

    const match = SIGNATURE_PATTERN.exec(request.header(SANDBOX_SIGNATURE_HEADER) ?? '');
    if (!match) throw PaymentErrors.webhookInvalid(401);
    const timestamp = Number(match[1]);
    if (Math.abs(nowMs / 1000 - timestamp) > SANDBOX_SIGNATURE_TOLERANCE_SECONDS) {
      throw PaymentErrors.webhookInvalid(401);
    }
    const expected = Buffer.from(
      signSandboxPayload(this.webhookKey, timestamp, raw).slice(-64),
      'hex',
    );
    const received = Buffer.from(match[2]!, 'hex');
    // Both are 32 bytes (the pattern fixes 64 hex digits): constant-time compare.
    if (!timingSafeEqual(expected, received)) throw PaymentErrors.webhookInvalid(401);
    return raw;
  }

  parseWebhook(rawBody: Buffer): ProviderEvent {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw PaymentErrors.webhookInvalid(400);
    }
    const parsed = payloadSchema.safeParse(decoded);
    if (!parsed.success) throw PaymentErrors.webhookInvalid(400);
    const event = parsed.data;
    const failed = event.type === 'payment.failed';
    return {
      providerEventId: event.id,
      type: failed ? 'PAYMENT_FAILED' : 'PAYMENT_SUCCEEDED',
      providerPaymentId: event.data.providerPaymentId,
      amountMinor: BigInt(event.data.amountMinor),
      currencyCode: event.data.currency,
      failureCode: failed
        ? (SANDBOX_FAILURES.get(event.data.failureReason ?? '') ?? 'UNKNOWN')
        : null,
      payloadHash: createHash('sha256').update(rawBody).digest('hex'),
    };
  }
}
