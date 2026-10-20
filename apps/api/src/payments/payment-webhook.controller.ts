import {
  Controller,
  Header,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiExcludeController,
  ApiNotFoundResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { PublicApiError } from '../auth/http/public-api-error.js';
import { PaymentErrors } from './payment.errors.js';
import { captureIdempotencyKey } from './payment-rules.js';
import type { PaymentProviderName, ProviderEvent } from './providers/payment-provider.js';
import { PaymentCapabilityRegistry } from './payment-capability.registry.js';
import { PaymentWebhookService } from './payment-webhook.service.js';

/**
 * Provider-to-server events. No user session and no CSRF: the request is
 * authenticated by the provider's signature over the raw body (HMAC,
 * constant-time comparison, bounded timestamp and size), and replays are
 * refused by the unique provider event id. The SANDBOX route only exists
 * when PAYMENT_PROVIDER=SANDBOX (never in staging or production), the Stripe
 * route only when PAYMENT_STRIPE_MODE is TEST or LIVE.
 */
@ApiExcludeController()
@Controller({ path: 'payments/webhooks', version: '1' })
export class PaymentWebhookController {
  constructor(
    private readonly webhooks: PaymentWebhookService,
    private readonly registry: PaymentCapabilityRegistry,
  ) {}

  @Post('sandbox')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Event authenticated, recorded and applied.' })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'PAYMENT_NOT_FOUND' })
  @ApiConflictResponse({ type: ErrorBody, description: 'PAYMENT_WEBHOOK_REPLAY and refusals' })
  async sandbox(@Req() request: RawBodyRequest<Request>) {
    const provider = this.registry.provider('SANDBOX');
    if (!provider) throw new NotFoundException();
    const raw = await provider.verifyWebhook(webhookRequest(request), Date.now());
    // SANDBOX events always carry a terminal result.
    const event = provider.parseWebhook(raw);
    if (!event || event.type === 'PAYMENT_APPROVED') throw PaymentErrors.webhookInvalid(400);
    const result = await this.webhooks.process(provider.name, event);
    if (result.error) throw result.error;
    return { received: true, outcome: result.outcome };
  }

  /**
   * Stripe events (PAY-EU-1), signed with the endpoint's secret (verified by
   * the official SDK on the raw body). Every authenticated event that was
   * recorded is acknowledged with 200, refusals included (their record is the
   * evidence, and Stripe would only redeliver the same payload); Stripe's
   * redelivery of an event already recorded with the same payload is
   * acknowledged too. An unknown payment answers 404, so Stripe retries once
   * the attempt carries its session id; the same event id with another
   * payload is refused (409).
   */
  @Post('stripe')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Event authenticated and recorded (or not ours / no result).' })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'PAYMENT_NOT_FOUND' })
  @ApiConflictResponse({ type: ErrorBody, description: 'PAYMENT_WEBHOOK_REPLAY' })
  async stripe(@Req() request: RawBodyRequest<Request>) {
    const provider = this.registry.provider('STRIPE');
    if (!provider) throw new NotFoundException();
    const raw = await provider.verifyWebhook(webhookRequest(request), Date.now());
    const event = provider.parseWebhook(raw);
    // Authentic, but no payment result (not ours, still processing, or unused).
    if (!event) return { received: true, outcome: 'IGNORED' };
    // Stripe Checkout has no separate approval step.
    if (event.type === 'PAYMENT_APPROVED') throw PaymentErrors.webhookInvalid(400);
    return this.terminal(provider.name, event);
  }

  /**
   * PayPal events (PAY-PAYPAL-1), authenticated by PayPal's own
   * verify-webhook-signature API with our webhook ID (the event is posted
   * back unchanged; PAYPAL-CERT-URL is never fetched here). When that check
   * cannot complete, 503: PayPal redelivers.
   *
   * - CHECKOUT.ORDER.APPROVED takes no money: if the attempt and its hold are
   *   still payable, the order is captured (outside any transaction, with a
   *   key derived from the payment reference, so a redelivery is the same
   *   capture), and nothing is confirmed. Otherwise nothing is captured
   *   (`CAPTURE_REFUSED`, acknowledged: an unknown order is not ours, and a
   *   redelivery would change nothing).
   * - PAYMENT.CAPTURE.COMPLETED is the only success; DENIED/DECLINED and
   *   CHECKOUT.PAYMENT-APPROVAL.REVERSED are failures; PENDING waits.
   *   Terminal events follow the Stripe rules above.
   */
  @Post('paypal')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Event authenticated and handled (or not ours / no result).' })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'PAYMENT_NOT_FOUND' })
  @ApiConflictResponse({ type: ErrorBody, description: 'PAYMENT_WEBHOOK_REPLAY' })
  async paypal(@Req() request: RawBodyRequest<Request>) {
    const provider = this.registry.provider('PAYPAL');
    if (!provider) throw new NotFoundException();
    const raw = await provider.verifyWebhook(webhookRequest(request), Date.now());
    const event = provider.parseWebhook(raw);
    if (!event) return { received: true, outcome: 'IGNORED' };
    if (event.type !== 'PAYMENT_APPROVED') return this.terminal(provider.name, event);

    const decision = await this.webhooks.prepareCapture(provider.name, event);
    if (!decision.capture) {
      return { received: true, outcome: 'CAPTURE_REFUSED', code: decision.refusal };
    }
    if (!provider.capturePayment) throw new Error('PayPal adapter cannot capture');
    const result = await provider.capturePayment(
      decision.providerPaymentId,
      captureIdempotencyKey(decision.paymentReference),
    );
    return { received: true, outcome: result };
  }

  /** A terminal event through the PAY-HUB-1 pipeline; identical redeliveries acknowledged. */
  private async terminal(provider: PaymentProviderName, event: ProviderEvent) {
    try {
      const result = await this.webhooks.process(provider, event);
      return result.error
        ? { received: true, outcome: result.outcome, code: result.error.code }
        : { received: true, outcome: result.outcome };
    } catch (error) {
      if (error instanceof PublicApiError && error.code === 'PAYMENT_WEBHOOK_REPLAY') {
        const recorded = await this.webhooks.recordedPayloadHash(provider, event.providerEventId);
        if (recorded === event.payloadHash) return { received: true, outcome: 'DUPLICATE' };
      }
      throw error;
    }
  }
}

/** The raw request as a provider sees it (headers by name, exact body bytes). */
function webhookRequest(request: RawBodyRequest<Request>) {
  return {
    rawBody: request.rawBody,
    contentType: request.header('content-type'),
    header: (name: string) => request.header(name),
  };
}
