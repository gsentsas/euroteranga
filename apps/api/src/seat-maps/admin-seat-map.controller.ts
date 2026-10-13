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
  SeatMapCellsBody,
  SeatMapCreateBody,
  SeatMapUpdateBody,
  seatMapCellsSchema,
  seatMapCreateSchema,
  seatMapListQuerySchema,
  seatMapUpdateSchema,
  seatMapVersionCreateSchema,
} from './seat-map.dto.js';
import { SeatMapService } from './seat-map.service.js';

const uuidV7 = new ParseUUIDPipe({ version: '7' });

/**
 * STAFF administration of seat maps. Every endpoint requires ops.access;
 * reads add seatmap.read, mutations seatmap.manage and a session-bound CSRF
 * token. There is no delete endpoint.
 */
@ApiTags('admin: seat maps')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/seat-maps', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminSeatMapController {
  constructor(private readonly seatMaps: SeatMapService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SEATMAP_READ)
  @ApiOkResponse({ description: 'Seat maps with version summaries and computed capacity.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'active', required: false, enum: ['true', 'false'] })
  list(
    @Query(new ZodValidationPipe(seatMapListQuerySchema))
    query: z.infer<typeof seatMapListQuerySchema>,
  ) {
    return this.seatMaps.listSeatMaps(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.SEATMAP_READ)
  @ApiOkResponse({ description: 'Seat map with versions, cells, capacity and usage.' })
  seatMap(@Param('id', uuidV7) id: string) {
    return this.seatMaps.seatMap(id);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.SEATMAP_MANAGE)
  @ApiCreatedResponse({ description: 'Seat map created and audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'SEAT_MAP_CODE_CONFLICT' })
  @ApiBody({ type: SeatMapCreateBody })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(seatMapCreateSchema)) body: z.infer<typeof seatMapCreateSchema>,
  ) {
    return this.seatMaps.createSeatMap(body, principal);
  }

  @Post(':id')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.SEATMAP_MANAGE)
  @ApiBody({ type: SeatMapUpdateBody })
  update(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(seatMapUpdateSchema)) body: z.infer<typeof seatMapUpdateSchema>,
  ) {
    return this.seatMaps.updateSeatMap(id, body, principal);
  }

  @Post(':id/versions')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.SEATMAP_MANAGE)
  @ApiCreatedResponse({ description: 'Next DRAFT version created and audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'SEAT_MAP_DRAFT_ALREADY_EXISTS' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  createVersion(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(seatMapVersionCreateSchema)) _body: Record<string, never>,
  ) {
    return this.seatMaps.createVersion(id, principal);
  }

  @Post(':id/versions/:versionId/cells')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.SEATMAP_MANAGE)
  @ApiOkResponse({ description: 'Complete DRAFT layout replaced atomically and audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'SEAT_MAP_VERSION_NOT_DRAFT' })
  @ApiUnprocessableEntityResponse({ type: ErrorBody, description: 'SEAT_MAP_CELLS_INVALID' })
  @ApiBody({ type: SeatMapCellsBody })
  replaceCells(
    @Param('id', uuidV7) id: string,
    @Param('versionId', uuidV7) versionId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(seatMapCellsSchema)) body: z.infer<typeof seatMapCellsSchema>,
  ) {
    return this.seatMaps.replaceCells(id, versionId, body, principal);
  }

  @Post(':id/versions/:versionId/publish')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.SEATMAP_MANAGE)
  @ApiOkResponse({ description: 'Version published; the previous one is retired.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'SEAT_MAP_VERSION_NOT_DRAFT' })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description: 'SEAT_MAP_VERSION_NOT_PUBLISHABLE',
  })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  publish(
    @Param('id', uuidV7) id: string,
    @Param('versionId', uuidV7) versionId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(seatMapVersionCreateSchema)) _body: Record<string, never>,
  ) {
    return this.seatMaps.publish(id, versionId, principal);
  }
}
