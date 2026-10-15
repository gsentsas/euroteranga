import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
import {
  permitCreateSchema,
  permitListQuerySchema,
  permitRevisionSchema,
  permitRevokeSchema,
  permitUpdateSchema,
} from './regulatory-permit.dto.js';
import { RegulatoryPermitService } from './regulatory-permit.service.js';

@ApiTags('admin: regulatory permits')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/regulatory-permits', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminRegulatoryPermitController {
  constructor(private readonly permits: RegulatoryPermitService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @RequirePermissions(PERMISSIONS.PERMIT_READ)
  @ApiOkResponse({ description: 'Bounded permit list with server-derived intrinsic validity.' })
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(permitListQuerySchema))
    query: z.infer<typeof permitListQuerySchema>,
  ) {
    return this.permits.list(principal, query);
  }

  @Get(':reference')
  @Header('Cache-Control', 'private, no-store')
  @RequirePermissions(PERMISSIONS.PERMIT_READ)
  @ApiOkResponse({ description: 'One permit and its mutation history; access is audited.' })
  detail(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.permits.detail(principal, reference);
  }

  @Post()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PERMIT_MANAGE)
  @ApiCreatedResponse({ description: 'A generic permit draft, transactionally audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'REGULATORY_PERMIT_DUPLICATE' })
  @ApiUnprocessableEntityResponse({ type: ErrorBody })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(permitCreateSchema))
    body: z.infer<typeof permitCreateSchema>,
  ) {
    return this.permits.create(body, principal);
  }

  @Post(':reference')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PERMIT_MANAGE)
  @ApiOkResponse({ description: 'A DRAFT permit updated with optimistic concurrency.' })
  @ApiConflictResponse({ type: ErrorBody })
  @ApiUnprocessableEntityResponse({ type: ErrorBody })
  update(
    @Param('reference') reference: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(permitUpdateSchema))
    body: z.infer<typeof permitUpdateSchema>,
  ) {
    return this.permits.update(reference, body, principal);
  }

  @Post(':reference/activate')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PERMIT_MANAGE)
  @ApiOkResponse({ description: 'DRAFT to ACTIVE; expiration remains derived.' })
  @ApiConflictResponse({ type: ErrorBody })
  activate(
    @Param('reference') reference: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(permitRevisionSchema))
    body: z.infer<typeof permitRevisionSchema>,
  ) {
    return this.permits.activate(reference, body.expectedRevision, principal);
  }

  @Post(':reference/revoke')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PERMIT_MANAGE)
  @ApiOkResponse({ description: 'ACTIVE to terminal REVOKED, with a mandatory reason.' })
  @ApiConflictResponse({ type: ErrorBody })
  revoke(
    @Param('reference') reference: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(permitRevokeSchema))
    body: z.infer<typeof permitRevokeSchema>,
  ) {
    return this.permits.revoke(reference, body.expectedRevision, body.reason, principal);
  }
}
