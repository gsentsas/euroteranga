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
import { borderCrewEventSchema } from './border.dto.js';
import { BorderService } from './border.service.js';

@ApiTags('crew: borders')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'crew/trips/:tripReference/borders', version: '1' })
@AuthRealmRoute('crew')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
export class CrewBorderController {
  constructor(private readonly borders: BorderService) {}

  @Post('events')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.CREW_BORDER_REPORT)
  event(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripReference') tripReference: string,
    @Body(new ZodValidationPipe(borderCrewEventSchema)) body: z.infer<typeof borderCrewEventSchema>,
  ) {
    return this.borders.recordCrew(actor, tripReference, body);
  }
}
