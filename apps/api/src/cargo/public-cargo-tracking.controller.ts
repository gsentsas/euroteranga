import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { CargoTrackingService } from './cargo-tracking.service.js';

@ApiTags('cargo tracking')
@Controller({ path: 'cargo-tracking', version: '1' })
export class PublicCargoTrackingController {
  constructor(private readonly tracking: CargoTrackingService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'PII-safe public road-freight tracking projection.' })
  @ApiNotFoundResponse({
    type: ErrorBody,
    description: 'Invalid, revoked or expired cargo tracking link.',
  })
  publicTracking(@Param('token') token: string) {
    return this.tracking.publicProjection(token);
  }
}
