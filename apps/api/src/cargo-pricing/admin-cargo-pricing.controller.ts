import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
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
import {
  CargoEstimateBody,
  CargoPricingRuleCreateBody,
  CargoPricingRuleUpdateBody,
  CargoPricingVersionBody,
  CargoPricingVersionCloneBody,
  cargoEstimateSchema,
  cargoPricingRuleCreateSchema,
  cargoPricingRuleListQuerySchema,
  cargoPricingRuleUpdateSchema,
  cargoPricingTransitionSchema,
  cargoPricingVersionCreateSchema,
  cargoPricingVersionUpdateSchema,
} from './cargo-pricing.dto.js';
import { CargoPricingService } from './cargo-pricing.service.js';

const uuidV7 = new ParseUUIDPipe({ version: '7' });

@ApiTags('admin: cargo pricing')
@ApiExtraModels(CargoPricingVersionBody, CargoPricingVersionCloneBody)
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'admin/pricing/cargo-rules', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminCargoPricingController {
  constructor(private readonly pricing: CargoPricingService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.PRICING_READ)
  @ApiOkResponse({ description: 'Versioned freight-pricing rule catalogue.' })
  list(
    @Query(new ZodValidationPipe(cargoPricingRuleListQuerySchema))
    query: z.infer<typeof cargoPricingRuleListQuerySchema>,
  ) {
    return this.pricing.list(query);
  }

  @Get(':ruleId')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.PRICING_READ)
  @ApiOkResponse({ description: 'One freight-pricing rule and its immutable history.' })
  detail(@Param('ruleId', uuidV7) ruleId: string) {
    return this.pricing.detail(ruleId);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @ApiCreatedResponse({ description: 'Stable freight-pricing rule identity created.' })
  @ApiBody({ type: CargoPricingRuleCreateBody })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(cargoPricingRuleCreateSchema))
    body: z.infer<typeof cargoPricingRuleCreateSchema>,
  ) {
    return this.pricing.createRule(body, principal);
  }

  @Post(':ruleId')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @ApiBody({ type: CargoPricingRuleUpdateBody })
  update(
    @Param('ruleId', uuidV7) ruleId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(cargoPricingRuleUpdateSchema))
    body: z.infer<typeof cargoPricingRuleUpdateSchema>,
  ) {
    return this.pricing.updateRule(ruleId, body, principal);
  }

  @Post(':ruleId/versions')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @ApiCreatedResponse({ description: 'Configured DRAFT, optionally cloned from one old version.' })
  @ApiBody({
    schema: {
      oneOf: [
        { $ref: '#/components/schemas/CargoPricingVersionBody' },
        { $ref: '#/components/schemas/CargoPricingVersionCloneBody' },
      ],
    },
  })
  createVersion(
    @Param('ruleId', uuidV7) ruleId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(cargoPricingVersionCreateSchema))
    body: z.infer<typeof cargoPricingVersionCreateSchema>,
  ) {
    return this.pricing.createVersion(ruleId, body, principal);
  }

  @Post(':ruleId/versions/:versionId')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @ApiBody({ type: CargoPricingVersionBody })
  updateVersion(
    @Param('ruleId', uuidV7) ruleId: string,
    @Param('versionId', uuidV7) versionId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(cargoPricingVersionUpdateSchema))
    body: z.infer<typeof cargoPricingVersionUpdateSchema>,
  ) {
    return this.pricing.updateVersion(ruleId, versionId, body, principal);
  }

  @Post(':ruleId/versions/:versionId/activate')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  activate(
    @Param('ruleId', uuidV7) ruleId: string,
    @Param('versionId', uuidV7) versionId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(cargoPricingTransitionSchema)) _body: Record<string, never>,
  ) {
    return this.pricing.activate(ruleId, versionId, principal);
  }

  @Post(':ruleId/versions/:versionId/disable')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  disable(
    @Param('ruleId', uuidV7) ruleId: string,
    @Param('versionId', uuidV7) versionId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(cargoPricingTransitionSchema)) _body: Record<string, never>,
  ) {
    return this.pricing.disable(ruleId, versionId, principal);
  }

  @Post(':ruleId/versions/:versionId/preview')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.PRICING_READ)
  @ApiBody({ type: CargoEstimateBody })
  @ApiOkResponse({ description: 'Side-effect-free preview of this exact version.' })
  preview(
    @Param('ruleId', uuidV7) ruleId: string,
    @Param('versionId', uuidV7) versionId: string,
    @Body(new ZodValidationPipe(cargoEstimateSchema)) body: z.infer<typeof cargoEstimateSchema>,
  ) {
    return this.pricing.preview(ruleId, versionId, body);
  }
}
