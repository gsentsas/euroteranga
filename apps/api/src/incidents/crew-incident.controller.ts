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
import { incidentCrewReportSchema } from './incident.dto.js';
import { IncidentService } from './incident.service.js';

@ApiTags('crew: incidents')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'crew/trips/:tripReference/incidents', version: '1' })
@AuthRealmRoute('crew')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
export class CrewIncidentController {
  constructor(private readonly incidents: IncidentService) {}

  @Post()
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.CREW_INCIDENT_REPORT)
  report(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripReference') tripReference: string,
    @Body(new ZodValidationPipe(incidentCrewReportSchema))
    body: z.infer<typeof incidentCrewReportSchema>,
  ) {
    return this.incidents.reportCrew(actor, tripReference, body);
  }
}
