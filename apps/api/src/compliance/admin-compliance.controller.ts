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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
import { ComplianceEvaluationService } from './compliance-evaluation.service.js';
import {
  complianceQueueQuerySchema,
  reviewCreateSchema,
  staffEvaluateSchema,
} from './compliance.dto.js';

/**
 * STAFF passenger compliance workspace: compliance.read for the audited
 * queue and detail, compliance.review (+ CSRF) to evaluate and to record a
 * reasoned human review. There is no bypass, override or delete route.
 */
@ApiTags('admin: passenger compliance')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@Controller({ path: 'admin/compliance', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminComplianceController {
  constructor(private readonly compliance: ComplianceEvaluationService) {}

  @Get('booking-passengers')
  @RequirePermissions(PERMISSIONS.COMPLIANCE_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description: 'Review queue (bounded scan, keyset cursor); each page is audited.',
  })
  queue(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(complianceQueueQuerySchema))
    query: z.infer<typeof complianceQueueQuerySchema>,
  ) {
    return this.compliance.queue(principal, query);
  }

  @Get('evaluations/:reference')
  @RequirePermissions(PERMISSIONS.COMPLIANCE_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description: 'Evaluation detail with rule versions, findings and reviews; audited.',
  })
  @ApiNotFoundResponse({ type: ErrorBody })
  detail(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.compliance.detail(principal, reference);
  }

  @Post('evaluations')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.COMPLIANCE_REVIEW)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description: 'Evaluated from server-side facts (deduplicated when nothing changed).',
  })
  @ApiNotFoundResponse({ type: ErrorBody })
  evaluate(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(staffEvaluateSchema)) body: z.infer<typeof staffEvaluateSchema>,
  ) {
    return this.compliance.staffEvaluate(principal, body);
  }

  @Post('evaluations/:reference/reviews')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.COMPLIANCE_REVIEW)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Append-only reasoned review of the current, latest evaluation.' })
  @ApiConflictResponse({
    type: ErrorBody,
    description:
      'COMPLIANCE_EVALUATION_STALE, COMPLIANCE_EVALUATION_SUPERSEDED or COMPLIANCE_REVIEW_CONFLICT',
  })
  review(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(reviewCreateSchema)) body: z.infer<typeof reviewCreateSchema>,
  ) {
    return this.compliance.review(principal, reference, body);
  }
}
