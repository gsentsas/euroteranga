import { Body, Controller, Get, Header, Param, Post, UseGuards } from '@nestjs/common';
import { ApiForbiddenResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import {
  trackingConfigSchema,
  trackingDeviceCreateSchema,
  trackingObservationSchema,
  trackingTokenIssueSchema,
  trackingTokenRevokeSchema,
  trackingUuidSchema,
} from './tracking.dto.js';
import { TrackingService } from './tracking.service.js';

@ApiTags('admin: tracking')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'admin/tracking', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
export class AdminTrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Get('trips')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.TRACKING_READ)
  trips() {
    return this.tracking.listTrips();
  }

  @Get('trips/:tripId')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.TRACKING_READ)
  trip(@Param('tripId', new ZodValidationPipe(trackingUuidSchema)) tripId: string) {
    return this.tracking.tripDetail(tripId);
  }

  @Get('devices')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.TRACKING_READ)
  devices() {
    return this.tracking.devices();
  }

  @Post('devices')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.TRACKING_MANAGE)
  createDevice(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Body(new ZodValidationPipe(trackingDeviceCreateSchema))
    body: z.infer<typeof trackingDeviceCreateSchema>,
  ) {
    return this.tracking.createDevice(actor, body);
  }

  @Post('trips/:tripId/config')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.TRACKING_MANAGE)
  configure(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripId', new ZodValidationPipe(trackingUuidSchema)) tripId: string,
    @Body(new ZodValidationPipe(trackingConfigSchema))
    body: z.infer<typeof trackingConfigSchema>,
  ) {
    return this.tracking.configure(actor, tripId, body);
  }

  @Post('trips/:tripId/observations')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.TRACKING_MANAGE)
  observe(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripId', new ZodValidationPipe(trackingUuidSchema)) tripId: string,
    @Body(new ZodValidationPipe(trackingObservationSchema))
    body: z.infer<typeof trackingObservationSchema>,
  ) {
    return this.tracking.recordOperationalObservation(actor, tripId, body);
  }

  @Post('trips/:tripId/public-tokens')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.TRACKING_MANAGE)
  issueToken(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripId', new ZodValidationPipe(trackingUuidSchema)) tripId: string,
    @Body(new ZodValidationPipe(trackingTokenIssueSchema))
    body: z.infer<typeof trackingTokenIssueSchema>,
  ) {
    return this.tracking.issuePublicToken(actor, tripId, body.expiresAt);
  }

  @Post('trips/:tripId/public-tokens/:tokenId/revoke')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.TRACKING_MANAGE)
  revokeToken(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripId', new ZodValidationPipe(trackingUuidSchema)) tripId: string,
    @Param('tokenId', new ZodValidationPipe(trackingUuidSchema)) tokenId: string,
    @Body(new ZodValidationPipe(trackingTokenRevokeSchema))
    body: z.infer<typeof trackingTokenRevokeSchema>,
  ) {
    return this.tracking.revokePublicToken(actor, tripId, tokenId, body.reason);
  }
}
