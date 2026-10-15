import { Body, Controller, Get, Header, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { manifestGenerationSchema, manifestListQuerySchema } from './manifest.dto.js';
import { ManifestService } from './manifest.service.js';

@ApiTags('admin: passenger manifests')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/manifests', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class ManifestController {
  constructor(private readonly manifests: ManifestService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.MANIFEST_READ)
  @Header('Cache-Control', 'private, no-store')
  @ApiOkResponse({ description: 'Bounded version history for one trip; access is audited.' })
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(manifestListQuerySchema))
    query: z.infer<typeof manifestListQuerySchema>,
  ) {
    return this.manifests.list(principal, query);
  }

  @Post('trips/:tripReference')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.MANIFEST_GENERATE)
  @Header('Cache-Control', 'private, no-store')
  @ApiCreatedResponse({ description: 'A new immutable version generated from current facts.' })
  generate(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('tripReference') tripReference: string,
    @Body(new ZodValidationPipe(manifestGenerationSchema))
    _body: z.infer<typeof manifestGenerationSchema>,
  ) {
    return this.manifests.generate(principal, tripReference);
  }

  @Get(':reference/export.csv')
  @RequirePermissions(PERMISSIONS.MANIFEST_EXPORT)
  @Header('Cache-Control', 'private, no-store')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOkResponse({ description: 'RFC 4180 CSV rendered only from the immutable snapshot.' })
  async exportCsv(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const exported = await this.manifests.exportCsv(principal, reference);
    response.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
    return exported.csv;
  }

  @Get(':reference')
  @RequirePermissions(PERMISSIONS.MANIFEST_READ)
  @Header('Cache-Control', 'private, no-store')
  @ApiOkResponse({ description: 'One immutable passenger snapshot; access is audited.' })
  detail(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.manifests.detail(principal, reference);
  }
}
