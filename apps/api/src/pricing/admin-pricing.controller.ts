import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiQuery,
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
  FareTableCreateBody,
  FareTableFaresBody,
  FareTableUpdateBody,
  FareTableVersionCreateBody,
  fareTableCreateSchema,
  fareTableFaresSchema,
  fareTableListQuerySchema,
  fareTablePublishSchema,
  fareTableUpdateSchema,
  fareTableVersionCreateSchema,
} from './pricing.dto.js';
import { PricingService } from './pricing.service.js';

const uuidV7 = new ParseUUIDPipe({ version: '7' });

/**
 * STAFF administration of base fare tables. Every endpoint requires
 * ops.access; reads add pricing.read, mutations pricing.manage and a
 * session-bound CSRF token. There is no delete endpoint.
 */
@ApiTags('admin: pricing')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/pricing', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminPricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get('fare-tables')
  @RequirePermissions(PERMISSIONS.PRICING_READ)
  @ApiOkResponse({ description: 'Fare tables with route, currency and version summaries.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'active', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'routeId', required: false, type: String, format: 'uuid' })
  list(
    @Query(new ZodValidationPipe(fareTableListQuerySchema))
    query: z.infer<typeof fareTableListQuerySchema>,
  ) {
    return this.pricing.listFareTables(query);
  }

  @Get('fare-tables/:id')
  @RequirePermissions(PERMISSIONS.PRICING_READ)
  @ApiOkResponse({
    description: 'Fare table with versions, waypoints, fares (amountMinor) and usage.',
  })
  fareTable(@Param('id', uuidV7) id: string) {
    return this.pricing.fareTable(id);
  }

  @Post('fare-tables')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @ApiCreatedResponse({ description: 'Fare table created and audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'FARE_TABLE_CODE_CONFLICT' })
  @ApiBody({ type: FareTableCreateBody })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(fareTableCreateSchema)) body: z.infer<typeof fareTableCreateSchema>,
  ) {
    return this.pricing.createFareTable(body, principal);
  }

  @Post('fare-tables/:id')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @ApiOkResponse({
    description: 'Name or active state updated (route and currency are immutable).',
  })
  @ApiBody({ type: FareTableUpdateBody })
  update(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(fareTableUpdateSchema)) body: z.infer<typeof fareTableUpdateSchema>,
  ) {
    return this.pricing.updateFareTable(id, body, principal);
  }

  @Post('fare-tables/:id/versions')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @ApiCreatedResponse({ description: 'Next DRAFT version created on a published route version.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'FARE_TABLE_DRAFT_ALREADY_EXISTS' })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description: 'FARE_TABLE_ROUTE_MISMATCH or FARE_TABLE_ROUTE_VERSION_NOT_PUBLISHED',
  })
  @ApiBody({ type: FareTableVersionCreateBody })
  createVersion(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(fareTableVersionCreateSchema))
    body: z.infer<typeof fareTableVersionCreateSchema>,
  ) {
    return this.pricing.createVersion(id, body.routeVersionId, principal);
  }

  @Post('fare-tables/:id/versions/:versionId/fares')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @ApiOkResponse({ description: 'Complete DRAFT matrix replaced atomically and audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'FARE_TABLE_VERSION_NOT_DRAFT' })
  @ApiUnprocessableEntityResponse({ type: ErrorBody, description: 'FARE_ENTRIES_INVALID' })
  @ApiBody({ type: FareTableFaresBody })
  replaceFares(
    @Param('id', uuidV7) id: string,
    @Param('versionId', uuidV7) versionId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(fareTableFaresSchema)) body: z.infer<typeof fareTableFaresSchema>,
  ) {
    return this.pricing.replaceFares(id, versionId, body, principal);
  }

  @Post('fare-tables/:id/versions/:versionId/publish')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PRICING_MANAGE)
  @ApiOkResponse({ description: 'Version published; the previous one is retired.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'FARE_TABLE_VERSION_NOT_DRAFT' })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description: 'FARE_TABLE_VERSION_NOT_PUBLISHABLE',
  })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  publish(
    @Param('id', uuidV7) id: string,
    @Param('versionId', uuidV7) versionId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(fareTablePublishSchema)) _body: Record<string, never>,
  ) {
    return this.pricing.publish(id, versionId, principal);
  }
}
