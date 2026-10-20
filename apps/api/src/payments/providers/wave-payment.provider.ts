import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from '@euroteranga/logger';
import { z } from 'zod';
import { PublicApiError } from '../../auth/http/public-api-error.js';
import { declaredCapability } from '../payment-capability.registry.js';
import { PaymentErrors } from '../payment.errors.js';
import { PAYMENT_REFERENCE_PATTERN } from '../payment-rules.js';
import type {
  PaymentProvider,
  ProviderCheckout,
  ProviderEvent,
  ProviderPaymentRequest,
  ProviderWebhookRequest,
} from './payment-provider.js';

export const WAVE_API_BASE_URL = 'https://api.wave.com';
export const WAVE_CHECKOUT_ORIGIN = 'https://pay.wave.com';
export const WAVE_SIGNATURE_HEADER = 'wave-signature';
export const WAVE_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
export const WAVE_FUTURE_TOLERANCE_SECONDS = 30;
export const WAVE_MAX_PAYLOAD_BYTES = 32 * 1024;
export const WAVE_MAX_RESPONSE_BYTES = 64 * 1024;
export const WAVE_TIMEOUT_MS = 10_000;

const MAX_SIGNATURE_HEADER_LENGTH = 1024;
const SESSION_ID = /^cos-[a-z0-9]{1,16}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{6,100}$/;
const XOF_AMOUNT = /^[1-9][0-9]{0,14}$/;

export interface WaveCheckoutSession {
  id: string;
  amount: string;
  checkout_status: string;
  client_reference: string | null;
  currency: string;
  error_url: string;
  payment_status: string;
  success_url: string;
  wave_launch_url: string;
  when_created: string;
  when_expires: string;
}

export interface WaveCheckoutCreate {
  amount: string;
  currency: 'XOF';
  client_reference: string;
  error_url: string;
  success_url: string;
}

/** Wave calls used by the adapter. Tests inject a fake; CI never reaches Wave. */
export interface WaveGateway {
  createCheckout(input: WaveCheckoutCreate): Promise<WaveCheckoutSession>;
  findCheckoutsByClientReference(reference: string): Promise<readonly WaveCheckoutSession[]>;
  expireCheckout(id: string): Promise<'EXPIRED' | 'CONFLICT'>;
  getCheckout(id: string): Promise<WaveCheckoutSession>;
}

class WaveRequestError extends Error {
  constructor(readonly statusCode: number | null) {
    super('Wave request failed');
  }
}

/** Exact API request signature: HMAC-SHA256(timestamp + raw body). */
export function waveSignature(secret: string, timestamp: number, rawBody: string | Buffer): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret)
    .update(String(timestamp))
    .update(rawBody)
    .digest('hex')}`;
}

/** Native fetch implementation: fixed origin, bounded time and response size. */
export class WaveHttpGateway implements WaveGateway {
  constructor(
    private readonly apiKey: string,
    private readonly requestSigningSecret: string,
    private readonly now: () => number = Date.now,
  ) {}

  createCheckout(input: WaveCheckoutCreate): Promise<WaveCheckoutSession> {
    return this.request('/v1/checkout/sessions', 'POST', JSON.stringify(input));
  }

  async findCheckoutsByClientReference(reference: string): Promise<readonly WaveCheckoutSession[]> {
    const result = await this.request<{ result: WaveCheckoutSession[] }>(
      `/v1/checkout/sessions/search?client_reference=${encodeURIComponent(reference)}`,
      'GET',
      '',
    );
    if (!Array.isArray(result.result)) throw new WaveRequestError(null);
    return result.result;
  }

  async expireCheckout(id: string): Promise<'EXPIRED' | 'CONFLICT'> {
    try {
      await this.request(`/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, 'POST', '');
      return 'EXPIRED';
    } catch (error) {
      if (error instanceof WaveRequestError && error.statusCode === 409) return 'CONFLICT';
      throw error;
    }
  }

  getCheckout(id: string): Promise<WaveCheckoutSession> {
    return this.request(`/v1/checkout/sessions/${encodeURIComponent(id)}`, 'GET', '');
  }

  private async request<T>(path: string, method: 'GET' | 'POST', body: string): Promise<T> {
    const timestamp = Math.floor(this.now() / 1000);
    let response: Response;
    try {
      response = await fetch(`${WAVE_API_BASE_URL}${path}`, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Wave-Signature': waveSignature(this.requestSigningSecret, timestamp, body),
        },
        ...(method === 'POST' && body ? { body } : {}),
        signal: AbortSignal.timeout(WAVE_TIMEOUT_MS),
      });
    } catch {
      throw new WaveRequestError(null);
    }
    if (!response.ok) throw new WaveRequestError(response.status);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > WAVE_MAX_RESPONSE_BYTES) {
      throw new WaveRequestError(response.status);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new WaveRequestError(response.status);
    }
    if (bytes.byteLength > WAVE_MAX_RESPONSE_BYTES) throw new WaveRequestError(response.status);
    if (bytes.byteLength === 0) return undefined as T;
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
    } catch {
      throw new WaveRequestError(response.status);
    }
  }
}

export interface WaveProviderOptions {
  webhookSecret: string;
  /** Client account return page, from server configuration only. */
  returnUrl: string;
  gateway: WaveGateway;
  logger: Logger;
}

const sessionSchema = z.object({
  id: z.string().regex(SESSION_ID),
  amount: z.string().regex(XOF_AMOUNT),
  checkout_status: z.enum(['open', 'complete', 'expired']),
  client_reference: z.string().max(255).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  error_url: z.string().url().max(2048),
  payment_status: z.enum(['processing', 'cancelled', 'succeeded']),
  success_url: z.string().url().max(2048),
  wave_launch_url: z.string().url().max(2048),
  when_created: z.string().datetime({ offset: true }),
  when_expires: z.string().datetime({ offset: true }),
});

const eventSchema = z.object({
  id: z.string().regex(EVENT_ID),
  type: z.string().min(1).max(100),
  data: z.unknown(),
});

// Wave's event catalogue shows the terminal fields only, while another
// official example carries the full Checkout Session. Require exactly the
// fields used to decide success and accept either documented representation.
const completedSessionSchema = sessionSchema.pick({
  id: true,
  amount: true,
  checkout_status: true,
  client_reference: true,
  currency: true,
  payment_status: true,
});

function waveErrorFields(error: unknown) {
  return { waveStatusCode: error instanceof WaveRequestError ? error.statusCode : null };
}

/** A positive XOF integer string, with no float conversion. */
export function xofMinorToWaveAmount(amountMinor: bigint): string {
  if (amountMinor <= 0n) throw PaymentErrors.quoteMismatch();
  const amount = amountMinor.toString();
  if (!XOF_AMOUNT.test(amount)) throw PaymentErrors.quoteMismatch();
  return amount;
}

/** PAY-SN-1A: direct Wave Senegal Checkout, disabled until a later LIVE gate. */
export class WavePaymentProvider implements PaymentProvider {
  readonly name = 'WAVE' as const;
  readonly testMode = false;
  readonly capability = declaredCapability('WAVE');

  private readonly successUrl: string;
  private readonly errorUrl: string;

  constructor(private readonly options: WaveProviderOptions) {
    const base = new URL(options.returnUrl);
    if (base.protocol !== 'https:' || base.username || base.password) {
      throw new Error('Wave return URL must be an HTTPS server configuration URL');
    }
    base.search = '';
    base.hash = '';
    const success = new URL(base);
    success.searchParams.set('paiement', 'retour-wave');
    const error = new URL(base);
    error.searchParams.set('paiement', 'abandon-wave');
    this.successUrl = success.toString();
    this.errorUrl = error.toString();
  }

  async createPayment(request: ProviderPaymentRequest): Promise<ProviderCheckout> {
    if (request.paymentMethod !== 'WAVE_SN') throw PaymentErrors.methodUnavailable();
    if (request.payerCountry !== 'SN') throw PaymentErrors.countryUnsupported();
    if (request.presentmentCurrencyCode !== 'XOF' || request.presentmentCurrencyMinorUnit !== 0) {
      throw PaymentErrors.currencyUnsupported();
    }
    const amount = xofMinorToWaveAmount(request.presentmentAmountMinor);
    const input: WaveCheckoutCreate = {
      amount,
      currency: 'XOF',
      client_reference: request.paymentReference,
      success_url: this.successUrl,
      error_url: this.errorUrl,
    };

    // Wave documents no native idempotency key. Search first, and search once
    // more after an unknown create result: never deliberately create two
    // payable checkouts for the same Payment.reference.
    let existing: readonly WaveCheckoutSession[];
    try {
      existing = await this.options.gateway.findCheckoutsByClientReference(
        request.paymentReference,
      );
    } catch (error) {
      this.logUnavailable('wave checkout search failed', request.paymentReference, error);
      throw PaymentErrors.providerUnavailable();
    }
    const recovered = this.singleSession(existing, input);
    if (recovered) return recovered;

    // Wave does not let us set an explicit Checkout expiry. A replay may
    // therefore create a fresh 30-minute session only while the safety margin
    // reserved at attempt creation can still cover that full collection
    // window. Otherwise Wave could remain payable after the booking hold.
    const collectionWindowSeconds = this.capability.collectionWindowSeconds;
    const expiresAtMs = request.expiresAt?.getTime() ?? Number.NaN;
    const originalHoldMarginSeconds =
      collectionWindowSeconds === null
        ? -1
        : this.capability.minimumHoldRemainingSeconds - collectionWindowSeconds;
    if (
      collectionWindowSeconds === null ||
      !Number.isFinite(expiresAtMs) ||
      originalHoldMarginSeconds < 0 ||
      Date.now() + collectionWindowSeconds * 1000 >
        expiresAtMs + originalHoldMarginSeconds * 1000
    ) {
      throw PaymentErrors.bookingExpired();
    }

    try {
      return await this.checkout(this.options.gateway.createCheckout(input), input);
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      this.logUnavailable('wave checkout create not confirmed', request.paymentReference, error);
      try {
        const after = await this.options.gateway.findCheckoutsByClientReference(
          request.paymentReference,
        );
        const found = this.singleSession(after, input);
        if (found) return found;
      } catch (recoveryError) {
        this.logUnavailable(
          'wave checkout recovery failed',
          request.paymentReference,
          recoveryError,
        );
      }
      throw PaymentErrors.providerUnavailable();
    }
  }

  async cancelPayment(providerPaymentId: string): Promise<'CLOSED' | 'COMPLETED'> {
    if (!SESSION_ID.test(providerPaymentId)) throw PaymentErrors.notFound();
    try {
      const result = await this.options.gateway.expireCheckout(providerPaymentId);
      if (result === 'EXPIRED') return 'CLOSED';
      const parsed = sessionSchema.safeParse(
        await this.options.gateway.getCheckout(providerPaymentId),
      );
      if (!parsed.success || parsed.data.id !== providerPaymentId) {
        throw new WaveRequestError(null);
      }
      if (parsed.data.checkout_status === 'expired') return 'CLOSED';
      if (
        parsed.data.checkout_status === 'complete' &&
        parsed.data.payment_status === 'succeeded'
      ) {
        return 'COMPLETED';
      }
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      this.options.logger.warn('wave checkout not expired', waveErrorFields(error));
      throw PaymentErrors.providerUnavailable();
    }
    throw PaymentErrors.providerUnavailable();
  }

  verifyWebhook(request: ProviderWebhookRequest, nowMs: number): Buffer {
    const contentType = (request.contentType ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') throw PaymentErrors.webhookInvalid(415);
    const raw = request.rawBody;
    if (!raw || raw.length === 0) throw PaymentErrors.webhookInvalid(400);
    if (raw.length > WAVE_MAX_PAYLOAD_BYTES) throw PaymentErrors.webhookInvalid(413);
    const header = request.header(WAVE_SIGNATURE_HEADER) ?? '';
    if (header.length === 0 || header.length > MAX_SIGNATURE_HEADER_LENGTH) {
      throw PaymentErrors.webhookInvalid(401);
    }
    const parts = header.split(',');
    const timestampText = parts.find((part) => part.startsWith('t='))?.slice(2);
    const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
    if (!timestampText || !/^\d{1,12}$/.test(timestampText) || signatures.length === 0) {
      throw PaymentErrors.webhookInvalid(401);
    }
    const timestamp = Number(timestampText);
    const nowSeconds = Math.floor(nowMs / 1000);
    if (
      timestamp < nowSeconds - WAVE_SIGNATURE_TOLERANCE_SECONDS ||
      timestamp > nowSeconds + WAVE_FUTURE_TOLERANCE_SECONDS
    ) {
      throw PaymentErrors.webhookInvalid(401);
    }
    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(timestampText)
      .update(raw)
      .digest();
    let valid = false;
    for (const signature of signatures) {
      if (!/^[a-f0-9]{64}$/.test(signature)) continue;
      const candidate = Buffer.from(signature, 'hex');
      const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
      valid = matches || valid;
    }
    if (!valid) throw PaymentErrors.webhookInvalid(401);
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
    // A failed attempt is not terminal: Wave explicitly says several failures
    // may precede a success. Cancelled/processing statuses likewise wait.
    if (event.data.type === 'checkout.session.payment_failed') return null;
    if (event.data.type !== 'checkout.session.completed') return null;
    const session = completedSessionSchema.safeParse(event.data.data);
    if (!session.success) throw PaymentErrors.webhookInvalid(400);
    if (
      session.data.checkout_status !== 'complete' ||
      session.data.payment_status !== 'succeeded' ||
      !session.data.client_reference ||
      !PAYMENT_REFERENCE_PATTERN.test(session.data.client_reference)
    ) {
      throw PaymentErrors.webhookInvalid(422);
    }
    return {
      providerEventId: event.data.id,
      type: 'PAYMENT_SUCCEEDED',
      providerPaymentId: session.data.id,
      paymentReference: session.data.client_reference,
      amountMinor: BigInt(session.data.amount),
      currencyCode: session.data.currency,
      failureCode: null,
      payloadHash: createHash('sha256').update(rawBody).digest('hex'),
    };
  }

  private singleSession(
    sessions: readonly WaveCheckoutSession[],
    expected: WaveCheckoutCreate,
  ): ProviderCheckout | null {
    if (sessions.length === 0) return null;
    if (sessions.length !== 1) throw PaymentErrors.providerUnavailable();
    return this.validatedCheckout(sessions[0]!, expected);
  }

  private async checkout(
    response: Promise<WaveCheckoutSession>,
    expected: WaveCheckoutCreate,
  ): Promise<ProviderCheckout> {
    return this.validatedCheckout(await response, expected);
  }

  private validatedCheckout(
    value: WaveCheckoutSession,
    expected: WaveCheckoutCreate,
  ): ProviderCheckout {
    const parsed = sessionSchema.safeParse(value);
    if (!parsed.success) throw PaymentErrors.providerUnavailable();
    const session = parsed.data;
    const created = Date.parse(session.when_created);
    const expires = Date.parse(session.when_expires);
    const launch = new URL(session.wave_launch_url);
    const validLaunch =
      launch.origin === WAVE_CHECKOUT_ORIGIN &&
      launch.username === '' &&
      launch.password === '' &&
      launch.hash === '' &&
      launch.pathname === `/c/${session.id}`;
    const validStatus =
      (session.checkout_status === 'open' && session.payment_status === 'processing') ||
      (session.checkout_status === 'complete' && session.payment_status === 'succeeded');
    if (
      session.amount !== expected.amount ||
      session.currency !== expected.currency ||
      session.client_reference !== expected.client_reference ||
      session.success_url !== expected.success_url ||
      session.error_url !== expected.error_url ||
      !validLaunch ||
      !validStatus ||
      !Number.isFinite(created) ||
      !Number.isFinite(expires) ||
      expires <= created ||
      expires - created > 30 * 60 * 1000 + 5_000
    ) {
      throw PaymentErrors.providerUnavailable();
    }
    return { providerPaymentId: session.id, redirectUrl: launch.toString() };
  }

  private logUnavailable(message: string, paymentReference: string, error: unknown): void {
    this.options.logger.warn(message, { paymentReference, ...waveErrorFields(error) });
  }
}
