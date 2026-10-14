import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
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
import { ComplianceRulesService } from './compliance-rules.service.js';
import {
  ruleCreateSchema,
  ruleListQuerySchema,
  ruleNextVersionSchema,
  rulePublishSchema,
  ruleRetireSchema,
  ruleVerifySchema,
  ruleVersionContentSchema,
} from './compliance.dto.js';

const versionNumber = new ParseIntPipe();

/**
 * STAFF regulatory rule catalogue. compliance.rule.read reads; every write
 * needs compliance.rule.manage and a session-bound CSRF token. Drafting,
 * verification, publication and retirement are separate operations; a
 * published version is never edited and nothing is deleted.
 * CODE_IS_NOT_LEGAL_AUTHORITY.
 */
@ApiTags('admin: compliance rules')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/compliance/rules', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminComplianceRulesController {
  constructor(private readonly rules: ComplianceRulesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.COMPLIANCE_RULE_READ)
  @ApiOkResponse({ description: 'Rules with their version summaries (keyset pagination).' })
  list(
    @Query(new ZodValidationPipe(ruleListQuerySchema)) query: z.infer<typeof ruleListQuerySchema>,
  ) {
    return this.rules.list(query);
  }

  @Get(':reference')
  @RequirePermissions(PERMISSIONS.COMPLIANCE_RULE_READ)
  @ApiOkResponse({ description: 'Rule with every version, definition and provenance.' })
  detail(@Param('reference') reference: string) {
    return this.rules.detail(reference);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.COMPLIANCE_RULE_MANAGE)
  @ApiCreatedResponse({ description: 'Rule created with an unverified DRAFT version 1.' })
  @ApiUnprocessableEntityResponse({ type: ErrorBody })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(ruleCreateSchema)) body: z.infer<typeof ruleCreateSchema>,
  ) {
    return this.rules.create(body, principal);
  }

  @Post(':reference/versions')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.COMPLIANCE_RULE_MANAGE)
  @ApiCreatedResponse({
    description: 'Next DRAFT version (given content or a copy of the latest).',
  })
  @ApiConflictResponse({ type: ErrorBody, description: 'COMPLIANCE_RULE_DRAFT_EXISTS' })
  createVersion(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(ruleNextVersionSchema)) body: z.infer<typeof ruleNextVersionSchema>,
  ) {
    return this.rules.createVersion(reference, body.version, principal);
  }

  @Post(':reference/versions/:version')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.COMPLIANCE_RULE_MANAGE)
  @ApiOkResponse({ description: 'DRAFT content replaced; its verification is dropped.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'COMPLIANCE_RULE_VERSION_NOT_DRAFT' })
  update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Param('version', versionNumber) version: number,
    @Body(new ZodValidationPipe(ruleVersionContentSchema))
    body: z.infer<typeof ruleVersionContentSchema>,
  ) {
    return this.rules.updateDraft(reference, version, body, principal);
  }

  @Post(':reference/versions/:version/verify')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.COMPLIANCE_RULE_MANAGE)
  @ApiOkResponse({ description: 'Exact definition verified against the cited official source.' })
  verify(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Param('version', versionNumber) version: number,
    @Body(new ZodValidationPipe(ruleVerifySchema)) body: z.infer<typeof ruleVerifySchema>,
  ) {
    return this.rules.verify(reference, version, body, principal);
  }

  @Post(':reference/versions/:version/publish')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.COMPLIANCE_RULE_MANAGE)
  @ApiOkResponse({ description: 'Verified, unchanged DRAFT published (immutable from now on).' })
  @ApiUnprocessableEntityResponse({ type: ErrorBody, description: 'COMPLIANCE_RULE_NOT_VERIFIED' })
  publish(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Param('version', versionNumber) version: number,
    @Body(new ZodValidationPipe(rulePublishSchema)) body: z.infer<typeof rulePublishSchema>,
  ) {
    return this.rules.publish(reference, version, body.definitionSha256, principal);
  }

  @Post(':reference/versions/:version/retire')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.COMPLIANCE_RULE_MANAGE)
  @ApiOkResponse({
    description: 'Published version withdrawn from future evaluations (kept as history).',
  })
  retire(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Param('version', versionNumber) version: number,
    @Body(new ZodValidationPipe(ruleRetireSchema)) body: z.infer<typeof ruleRetireSchema>,
  ) {
    return this.rules.retire(reference, version, body.reason, principal);
  }
}
