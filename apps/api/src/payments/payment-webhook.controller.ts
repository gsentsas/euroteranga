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
import { PaymentCapabilityRegistry } from './payment-capability.registry.js';
import { PaymentWebhookService } from './payment-webhook.service.js';

/**
 * Provider-to-server events. No user session and no CSRF: the request is
 * authenticated by the provider's signature over the raw body (HMAC,
 * constant-time comparison, bounded timestamp and size), and replays are
 * refused by the unique provider event id. The SANDBOX route only exists
 * when PAYMENT_PROVIDER=SANDBOX (never in staging or production).
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
    const raw = provider.verifyWebhook(
      {
        rawBody: request.rawBody,
        contentType: request.header('content-type'),
        header: (name) => request.header(name),
      },
      Date.now(),
    );
    const result = await this.webhooks.process(provider.name, provider.parseWebhook(raw));
    if (result.error) throw result.error;
    return { received: true, outcome: result.outcome };
  }
}
