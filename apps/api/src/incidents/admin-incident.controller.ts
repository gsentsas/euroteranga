import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiForbiddenResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import {
  AuthRequestGuard,
  CsrfGuard,
  MultipartRoute,
  SessionGuard,
} from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import {
  incidentActionSchema,
  incidentAttachmentIdSchema,
  incidentListQuerySchema,
  incidentOpenStaffSchema,
  incidentOwnerSchema,
  incidentReferenceSchema,
  incidentTransitionSchema,
} from './incident.dto.js';
import { IncidentService } from './incident.service.js';

function attachmentFilename(reference: string, mimeType: string): string {
  const extension =
    mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/jpeg' ? 'jpg' : 'png';
  return reference + '-piece-jointe.' + extension;
}

@ApiTags('admin: incidents')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'admin/incidents', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
export class AdminIncidentController {
  constructor(private readonly incidents: IncidentService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.INCIDENT_READ)
  list(
    @Query(new ZodValidationPipe(incidentListQuerySchema))
    query: z.infer<typeof incidentListQuerySchema>,
  ) {
    return this.incidents.list(query);
  }

  @Get('owners')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.INCIDENT_MANAGE)
  owners() {
    return this.incidents.owners();
  }

  @Get(':reference')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.INCIDENT_READ)
  detail(@Param('reference', new ZodValidationPipe(incidentReferenceSchema)) reference: string) {
    return this.incidents.detail(reference);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.INCIDENT_MANAGE)
  open(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Body(new ZodValidationPipe(incidentOpenStaffSchema))
    body: z.infer<typeof incidentOpenStaffSchema>,
  ) {
    return this.incidents.openStaff(actor, body);
  }

  @Post(':reference/attachments')
  @MultipartRoute()
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.INCIDENT_MANAGE)
  uploadAttachment(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('reference', new ZodValidationPipe(incidentReferenceSchema)) reference: string,
    @Req() request: Request,
  ) {
    return this.incidents.uploadAttachment(actor, reference, request);
  }

  @Get(':reference/attachments/:attachmentId/download')
  @RequirePermissions(PERMISSIONS.INCIDENT_READ)
  async downloadAttachment(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('reference', new ZodValidationPipe(incidentReferenceSchema)) reference: string,
    @Param('attachmentId', new ZodValidationPipe(incidentAttachmentIdSchema))
    attachmentId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { attachment, stored } = await this.incidents.downloadAttachment(
      actor,
      reference,
      attachmentId,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', attachment.mimeType);
    response.setHeader('Content-Length', String(stored.sizeBytes));
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="' + attachmentFilename(reference, attachment.mimeType) + '"',
    );
    return new StreamableFile(stored.body);
  }

  @Post(':reference/actions')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.INCIDENT_MANAGE)
  action(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('reference', new ZodValidationPipe(incidentReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(incidentActionSchema)) body: z.infer<typeof incidentActionSchema>,
  ) {
    return this.incidents.addAction(actor, reference, body);
  }

  @Post(':reference/transition')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.INCIDENT_MANAGE)
  transition(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('reference', new ZodValidationPipe(incidentReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(incidentTransitionSchema))
    body: z.infer<typeof incidentTransitionSchema>,
  ) {
    return this.incidents.transition(actor, reference, body);
  }

  @Post(':reference/owner')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.INCIDENT_MANAGE)
  owner(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('reference', new ZodValidationPipe(incidentReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(incidentOwnerSchema)) body: z.infer<typeof incidentOwnerSchema>,
  ) {
    return this.incidents.assignOwner(actor, reference, body);
  }
}
