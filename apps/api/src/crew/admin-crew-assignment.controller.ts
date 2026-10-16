import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiForbiddenResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { crewAssignmentCreateSchema, crewAssignmentRevokeSchema } from './crew.dto.js';
import { CrewService } from './crew.service.js';

const uuidV7 = new ParseUUIDPipe({ version: '7' });

@ApiTags('admin: crew assignments')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'admin/trips', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS, PERMISSIONS.TRIP_MANAGE)
export class AdminCrewAssignmentController {
  constructor(private readonly crew: CrewService) {}

  @Get(':tripId/crew-assignments')
  assignments(@Param('tripId', uuidV7) tripId: string) {
    return this.crew.assignments(tripId);
  }

  @Post(':tripId/crew-assignments')
  @UseGuards(CsrfGuard)
  assign(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripId', uuidV7) tripId: string,
    @Body(new ZodValidationPipe(crewAssignmentCreateSchema))
    body: z.infer<typeof crewAssignmentCreateSchema>,
  ) {
    return this.crew.assign(actor, tripId, body);
  }

  @Post(':tripId/crew-assignments/:assignmentId/revoke')
  @UseGuards(CsrfGuard)
  revoke(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripId', uuidV7) tripId: string,
    @Param('assignmentId', uuidV7) assignmentId: string,
    @Body(new ZodValidationPipe(crewAssignmentRevokeSchema))
    body: z.infer<typeof crewAssignmentRevokeSchema>,
  ) {
    return this.crew.revokeAssignment(actor, tripId, assignmentId, body);
  }
}
