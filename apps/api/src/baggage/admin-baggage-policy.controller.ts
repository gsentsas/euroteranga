import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import {
  baggagePolicyCreateSchema,
  baggagePolicyListQuerySchema,
  baggagePolicyPublishSchema,
  baggagePolicyTiersSchema,
  baggagePolicyUpdateSchema,
  baggagePolicyVersionCreateSchema,
} from './baggage-policy.dto.js';
import { BaggagePolicyService } from './baggage-policy.service.js';

@ApiTags('admin: baggage policies')
@Controller({ path: 'admin/baggage-policies', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS, PERMISSIONS.PRICING_READ)
export class AdminBaggagePolicyController {
  constructor(private readonly policies: BaggagePolicyService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Versioned baggage allowance policies.' })
  list(
    @Query(new ZodValidationPipe(baggagePolicyListQuerySchema))
    query: z.infer<typeof baggagePolicyListQuerySchema>,
  ) {
    return this.policies.list(query);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'One baggage policy with historical versions and tiers.' })
  detail(@Param('id') id: string) {
    return this.policies.detail(id);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Create a baggage policy catalogue identity.' })
  create(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Body(new ZodValidationPipe(baggagePolicyCreateSchema))
    body: z.infer<typeof baggagePolicyCreateSchema>,
  ) {
    return this.policies.create(body, actor);
  }

  @Post(':id')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(baggagePolicyUpdateSchema))
    body: z.infer<typeof baggagePolicyUpdateSchema>,
  ) {
    return this.policies.update(id, body, actor);
  }

  @Post(':id/versions')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Create the next DRAFT baggage policy version.' })
  createVersion(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(baggagePolicyVersionCreateSchema))
    body: z.infer<typeof baggagePolicyVersionCreateSchema>,
  ) {
    return this.policies.createVersion(id, body, actor);
  }

  @Post(':id/versions/:versionId/tiers')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @Header('Cache-Control', 'no-store')
  replaceTiers(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(baggagePolicyTiersSchema))
    body: z.infer<typeof baggagePolicyTiersSchema>,
  ) {
    return this.policies.replaceTiers(id, versionId, body, actor);
  }

  @Post(':id/versions/:versionId/publish')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @Header('Cache-Control', 'no-store')
  publish(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(baggagePolicyPublishSchema))
    _body: z.infer<typeof baggagePolicyPublishSchema>,
  ) {
    return this.policies.publish(id, versionId, actor);
  }
}
