import { Body, Controller, Header, Param, Post, UseGuards } from '@nestjs/common';
import { ApiForbiddenResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { trackingCrewCheckpointSchema } from './tracking.dto.js';
import { TrackingService } from './tracking.service.js';

@ApiTags('crew: tracking')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'crew/trips/:tripReference/tracking', version: '1' })
@AuthRealmRoute('crew')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
export class CrewTrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Post('checkpoints')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.CREW_TRACKING_REPORT)
  checkpoint(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripReference') tripReference: string,
    @Body(new ZodValidationPipe(trackingCrewCheckpointSchema))
    body: z.infer<typeof trackingCrewCheckpointSchema>,
  ) {
    return this.tracking.recordCrewCheckpoint(actor, tripReference, body);
  }
}
