import { Body, Controller, Get, Header, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import {
  crewDeviceEnrollSchema,
  crewDeviceIdSchema,
  crewDeviceRevokeSchema,
  crewSyncSchema,
} from './crew.dto.js';
import { CrewService } from './crew.service.js';

@ApiTags('crew')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'crew', version: '1' })
@AuthRealmRoute('crew')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
export class CrewController {
  constructor(private readonly crew: CrewService) {}

  @Get('trips')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.CREW_TRIP_READ)
  @ApiOkResponse({ description: 'Only live trips assigned to the authenticated Crew identity.' })
  trips(@CurrentPrincipal() actor: AuthPrincipal) {
    return this.crew.trips(actor);
  }

  @Get('trips/:tripReference')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.CREW_TRIP_READ)
  trip(@CurrentPrincipal() actor: AuthPrincipal, @Param('tripReference') tripReference: string) {
    return this.crew.trip(actor, tripReference);
  }

  @Get('devices/:deviceId')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.CREW_DEVICE_MANAGE)
  device(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('deviceId', new ZodValidationPipe(crewDeviceIdSchema)) deviceId: string,
  ) {
    return this.crew.device(actor, deviceId);
  }

  @Post('devices/enroll')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.CREW_DEVICE_MANAGE)
  enroll(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Body(new ZodValidationPipe(crewDeviceEnrollSchema))
    body: z.infer<typeof crewDeviceEnrollSchema>,
  ) {
    return this.crew.enrollDevice(actor, body);
  }

  @Post('devices/:deviceId/revoke')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.CREW_DEVICE_MANAGE)
  revoke(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('deviceId', new ZodValidationPipe(crewDeviceIdSchema)) deviceId: string,
    @Body(new ZodValidationPipe(crewDeviceRevokeSchema))
    body: z.infer<typeof crewDeviceRevokeSchema>,
  ) {
    return this.crew.revokeDevice(actor, deviceId, body);
  }

  @Post('trips/:tripReference/events/sync')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.CREW_BOARDING_SCAN)
  sync(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripReference') tripReference: string,
    @Body(new ZodValidationPipe(crewSyncSchema)) body: z.infer<typeof crewSyncSchema>,
  ) {
    return this.crew.sync(actor, tripReference, body);
  }
}
