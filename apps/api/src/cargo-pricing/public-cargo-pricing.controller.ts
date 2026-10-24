import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags, ApiTooManyRequestsResponse } from '@nestjs/swagger';
import type { z } from 'zod';
import { ClientIp } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import { CargoEstimateBody, cargoEstimateSchema } from './cargo-pricing.dto.js';
import { CargoPricingService } from './cargo-pricing.service.js';

@ApiTags('cargo pricing')
@Controller({ path: 'cargo', version: '1' })
export class PublicCargoPricingController {
  constructor(private readonly pricing: CargoPricingService) {}

  @Post('estimate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiBody({ type: CargoEstimateBody })
  @ApiOkResponse({
    description:
      'Exact versioned estimate, or requiresQuote=true with a stable fail-closed reason.',
  })
  @ApiTooManyRequestsResponse({ description: 'Per-IP public estimate limit exceeded.' })
  estimate(
    @Body(new ZodValidationPipe(cargoEstimateSchema)) body: z.infer<typeof cargoEstimateSchema>,
    @ClientIp() clientIp: string,
  ) {
    return this.pricing.estimate(body, clientIp);
  }
}
