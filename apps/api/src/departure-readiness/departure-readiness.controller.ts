import { Body, Controller, Get, Header, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { departureActionSchema, departurePermitPolicySchema } from './departure-readiness.dto.js';
import { DepartureReadinessService } from './departure-readiness.service.js';

@ApiTags('admin: departure readiness')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/departure', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class DepartureReadinessController {
  constructor(private readonly departures: DepartureReadinessService) {}

  @Get('trips/:tripReference/readiness')
  @Header('Cache-Control', 'private, no-store')
  @RequirePermissions(PERMISSIONS.DEPARTURE_READ)
  @ApiOkResponse({
    description: 'Server-authoritative whole-trip readiness and current authorization.',
  })
  readiness(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('tripReference') tripReference: string,
  ) {
    return this.departures.readiness(tripReference, principal);
  }

  @Post('trips/:tripReference/permit-policy')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.DEPARTURE_MANAGE)
  @ApiCreatedResponse({ description: 'Publishes one immutable version of the trip permit policy.' })
  @ApiConflictResponse({ type: ErrorBody })
  @ApiUnprocessableEntityResponse({ type: ErrorBody })
  publishPermitPolicy(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('tripReference') tripReference: string,
    @Body(new ZodValidationPipe(departurePermitPolicySchema))
    body: z.infer<typeof departurePermitPolicySchema>,
  ) {
    return this.departures.publishPermitPolicy(tripReference, body, principal);
  }

  @Post('trips/:tripReference/authorize')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.DEPARTURE_AUTHORIZE)
  @ApiOkResponse({
    description: 'Creates or reuses the immutable authorization for the current READY fingerprint.',
  })
  @ApiConflictResponse({ type: ErrorBody })
  authorize(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('tripReference') tripReference: string,
    @Body(new ZodValidationPipe(departureActionSchema)) _body: Record<string, never>,
  ) {
    return this.departures.authorize(tripReference, principal);
  }

  @Post('trips/:tripReference/depart')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.DEPARTURE_MANAGE)
  @ApiOkResponse({ description: 'Revalidates authorization and records SCHEDULED to IN_PROGRESS.' })
  @ApiConflictResponse({ type: ErrorBody })
  depart(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('tripReference') tripReference: string,
    @Body(new ZodValidationPipe(departureActionSchema)) _body: Record<string, never>,
  ) {
    return this.departures.depart(tripReference, principal);
  }

  @Post('trips/:tripReference/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.DEPARTURE_MANAGE)
  @ApiOkResponse({
    description: 'Records IN_PROGRESS to COMPLETED with a database-owned arrival time.',
  })
  @ApiConflictResponse({ type: ErrorBody })
  complete(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('tripReference') tripReference: string,
    @Body(new ZodValidationPipe(departureActionSchema)) _body: Record<string, never>,
  ) {
    return this.departures.complete(tripReference, principal);
  }
}
