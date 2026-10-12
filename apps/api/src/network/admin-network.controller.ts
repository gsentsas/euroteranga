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
  ApiExtraModels,
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
  CheckpointCreateBody,
  CheckpointUpdateBody,
  CheckpointWaypointBody,
  CountryCreateBody,
  CountryUpdateBody,
  ReplaceWaypointsBody,
  RouteCreateBody,
  RouteUpdateBody,
  StopCreateBody,
  StopUpdateBody,
  StopWaypointBody,
  checkpointCreateSchema,
  checkpointUpdateSchema,
  countryCreateSchema,
  countryUpdateSchema,
  networkListQuerySchema,
  replaceWaypointsSchema,
  routeCreateSchema,
  routeUpdateSchema,
  routeVersionCreateSchema,
  stopCreateSchema,
  stopUpdateSchema,
} from './network.dto.js';
import { NetworkService } from './network.service.js';

const uuidV7 = new ParseUUIDPipe({ version: '7' });

/**
 * STAFF administration of network reference data and versioned routes.
 * Every endpoint also requires ops.access; mutations add network.manage and
 * a session-bound CSRF token. Permissions remain enforced by the API even
 * when the OPS interface hides an action.
 */
@ApiTags('admin: network')
@ApiExtraModels(StopWaypointBody, CheckpointWaypointBody)
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@ApiConflictResponse({ type: ErrorBody })
@ApiUnprocessableEntityResponse({ type: ErrorBody })
@Controller({ path: 'admin/network', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminNetworkController {
  constructor(private readonly network: NetworkService) {}

  @Get('countries')
  @RequirePermissions(PERMISSIONS.NETWORK_READ)
  @ApiOkResponse({ description: 'Countries, newest first, using UUIDv7 keyset pagination.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  countries(
    @Query(new ZodValidationPipe(networkListQuerySchema))
    query: z.infer<typeof networkListQuerySchema>,
  ) {
    return this.network.listCountries(query);
  }

  @Post('countries')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.NETWORK_MANAGE)
  @ApiCreatedResponse({ description: 'Country created and audited.' })
  @ApiBody({ type: CountryCreateBody })
  createCountry(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(countryCreateSchema)) body: z.infer<typeof countryCreateSchema>,
  ) {
    return this.network.createCountry(body, principal);
  }

  @Post('countries/:id')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.NETWORK_MANAGE)
  @ApiBody({ type: CountryUpdateBody })
  updateCountry(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(countryUpdateSchema)) body: z.infer<typeof countryUpdateSchema>,
  ) {
    return this.network.updateCountry(id, body, principal);
  }

  @Get('stops')
  @RequirePermissions(PERMISSIONS.NETWORK_READ)
  @ApiOkResponse({ description: 'Stops with their country, using UUIDv7 keyset pagination.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  stops(
    @Query(new ZodValidationPipe(networkListQuerySchema))
    query: z.infer<typeof networkListQuerySchema>,
  ) {
    return this.network.listStops(query);
  }

  @Post('stops')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.NETWORK_MANAGE)
  @ApiCreatedResponse({ description: 'Stop created and audited.' })
  @ApiBody({ type: StopCreateBody })
  createStop(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(stopCreateSchema)) body: z.infer<typeof stopCreateSchema>,
  ) {
    return this.network.createStop(body, principal);
  }

  @Post('stops/:id')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.NETWORK_MANAGE)
  @ApiBody({ type: StopUpdateBody })
  updateStop(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(stopUpdateSchema)) body: z.infer<typeof stopUpdateSchema>,
  ) {
    return this.network.updateStop(id, body, principal);
  }

  @Get('checkpoints')
  @RequirePermissions(PERMISSIONS.NETWORK_READ)
  @ApiOkResponse({ description: 'Checkpoints with their country, using keyset pagination.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  checkpoints(
    @Query(new ZodValidationPipe(networkListQuerySchema))
    query: z.infer<typeof networkListQuerySchema>,
  ) {
    return this.network.listCheckpoints(query);
  }

  @Post('checkpoints')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.NETWORK_MANAGE)
  @ApiCreatedResponse({ description: 'Checkpoint created and audited.' })
  @ApiBody({ type: CheckpointCreateBody })
  createCheckpoint(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(checkpointCreateSchema))
    body: z.infer<typeof checkpointCreateSchema>,
  ) {
    return this.network.createCheckpoint(body, principal);
  }

  @Post('checkpoints/:id')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.NETWORK_MANAGE)
  @ApiBody({ type: CheckpointUpdateBody })
  updateCheckpoint(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(checkpointUpdateSchema))
    body: z.infer<typeof checkpointUpdateSchema>,
  ) {
    return this.network.updateCheckpoint(id, body, principal);
  }

  @Get('routes')
  @RequirePermissions(PERMISSIONS.NETWORK_READ)
  @ApiOkResponse({ description: 'Routes and version summaries, using keyset pagination.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  routes(
    @Query(new ZodValidationPipe(networkListQuerySchema))
    query: z.infer<typeof networkListQuerySchema>,
  ) {
    return this.network.listRoutes(query);
  }

  @Get('routes/:id')
  @RequirePermissions(PERMISSIONS.NETWORK_READ)
  @ApiOkResponse({ description: 'Route with ordered versions and ordered waypoints.' })
  route(@Param('id', uuidV7) id: string) {
    return this.network.route(id);
  }

  @Post('routes')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.NETWORK_MANAGE)
  @ApiCreatedResponse({ description: 'Route created and audited.' })
  @ApiBody({ type: RouteCreateBody })
  createRoute(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(routeCreateSchema)) body: z.infer<typeof routeCreateSchema>,
  ) {
    return this.network.createRoute(body, principal);
  }

  @Post('routes/:id')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.NETWORK_MANAGE)
  @ApiBody({ type: RouteUpdateBody })
  updateRoute(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(routeUpdateSchema)) body: z.infer<typeof routeUpdateSchema>,
  ) {
    return this.network.updateRoute(id, body, principal);
  }

  @Post('routes/:id/versions')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.NETWORK_MANAGE)
  @ApiCreatedResponse({ description: 'Next DRAFT version created and audited.' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  createVersion(
    @Param('id', uuidV7) routeId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(routeVersionCreateSchema)) _body: Record<string, never>,
  ) {
    return this.network.createRouteVersion(routeId, principal);
  }

  @Post('routes/:id/versions/:versionId/waypoints')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.NETWORK_MANAGE)
  @ApiBody({ type: ReplaceWaypointsBody })
  replaceWaypoints(
    @Param('id', uuidV7) routeId: string,
    @Param('versionId', uuidV7) versionId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(replaceWaypointsSchema))
    body: z.infer<typeof replaceWaypointsSchema>,
  ) {
    return this.network.replaceWaypoints(routeId, versionId, body, principal);
  }

  @Post('routes/:id/versions/:versionId/publish')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.NETWORK_MANAGE)
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  publishVersion(
    @Param('id', uuidV7) routeId: string,
    @Param('versionId', uuidV7) versionId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(routeVersionCreateSchema)) _body: Record<string, never>,
  ) {
    return this.network.publishRouteVersion(routeId, versionId, principal);
  }
}
