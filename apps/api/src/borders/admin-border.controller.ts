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
import { borderStaffEventSchema, borderUuidSchema } from './border.dto.js';
import { BorderService } from './border.service.js';

@ApiTags('admin: borders')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'admin/borders', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
export class AdminBorderController {
  constructor(private readonly borders: BorderService) {}

  @Get('trips/:tripId')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.BORDER_READ)
  trip(@Param('tripId', new ZodValidationPipe(borderUuidSchema)) tripId: string) {
    return this.borders.listTrip(tripId);
  }

  @Post('trips/:tripId/events')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.BORDER_MANAGE)
  event(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripId', new ZodValidationPipe(borderUuidSchema)) tripId: string,
    @Body(new ZodValidationPipe(borderStaffEventSchema))
    body: z.infer<typeof borderStaffEventSchema>,
  ) {
    return this.borders.recordStaff(actor, tripId, body);
  }
}
