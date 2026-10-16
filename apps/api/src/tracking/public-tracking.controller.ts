import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { TrackingService } from './tracking.service.js';

@ApiTags('tracking')
@Controller({ path: 'tracking', version: '1' })
export class PublicTrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Visibility-safe public trip tracking projection.' })
  @ApiNotFoundResponse({
    type: ErrorBody,
    description: 'Invalid, revoked, expired or hidden tracking.',
  })
  publicTracking(@Param('token') token: string) {
    return this.tracking.publicProjection(token);
  }
}
