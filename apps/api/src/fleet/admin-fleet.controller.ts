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
  VehicleCreateBody,
  VehicleSeatMapBody,
  VehicleStatusBody,
  VehicleUpdateBody,
  vehicleCreateSchema,
  vehicleListQuerySchema,
  vehicleSeatMapSchema,
  vehicleStatusSchema,
  vehicleUpdateSchema,
} from './fleet.dto.js';
import { FleetService } from './fleet.service.js';

const uuidV7 = new ParseUUIDPipe({ version: '7' });

/**
 * STAFF administration of the vehicle registry. Every endpoint requires
 * ops.access; reads add fleet.read, mutations fleet.manage and a
 * session-bound CSRF token. There is no delete endpoint: vehicles are
 * retired through the status transition.
 */
@ApiTags('admin: fleet')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/fleet', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminFleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get('vehicles')
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @ApiOkResponse({ description: 'Vehicles, newest first, using UUIDv7 keyset pagination.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PLANNED', 'ACTIVE', 'OUT_OF_SERVICE', 'RETIRED'],
  })
  vehicles(
    @Query(new ZodValidationPipe(vehicleListQuerySchema))
    query: z.infer<typeof vehicleListQuerySchema>,
  ) {
    return this.fleet.listVehicles(query);
  }

  @Get('vehicles/:id')
  @RequirePermissions(PERMISSIONS.FLEET_READ)
  @ApiOkResponse({ description: 'Vehicle with its status history (from the audit trail).' })
  vehicle(@Param('id', uuidV7) id: string) {
    return this.fleet.vehicle(id);
  }

  @Post('vehicles')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @ApiCreatedResponse({ description: 'Vehicle registered as PLANNED and audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'VEHICLE_IDENTIFIER_CONFLICT' })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description: 'VEHICLE_REGISTRATION_INCOMPLETE',
  })
  @ApiBody({ type: VehicleCreateBody })
  createVehicle(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(vehicleCreateSchema)) body: z.infer<typeof vehicleCreateSchema>,
  ) {
    return this.fleet.createVehicle(body, principal);
  }

  @Post('vehicles/:id')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @ApiOkResponse({ description: 'Administrative data updated and audited (not the status).' })
  @ApiConflictResponse({
    type: ErrorBody,
    description: 'VEHICLE_IDENTIFIER_CONFLICT or VEHICLE_RETIRED',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description: 'VEHICLE_REGISTRATION_INCOMPLETE',
  })
  @ApiBody({ type: VehicleUpdateBody })
  updateVehicle(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(vehicleUpdateSchema)) body: z.infer<typeof vehicleUpdateSchema>,
  ) {
    return this.fleet.updateVehicle(id, body, principal);
  }

  @Post('vehicles/:id/status')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE)
  @ApiOkResponse({ description: 'Status changed and audited with its reason.' })
  @ApiConflictResponse({
    type: ErrorBody,
    description: 'VEHICLE_STATUS_TRANSITION_INVALID or VEHICLE_STATUS_CONFLICT',
  })
  @ApiBody({ type: VehicleStatusBody })
  changeStatus(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(vehicleStatusSchema)) body: z.infer<typeof vehicleStatusSchema>,
  ) {
    return this.fleet.changeStatus(id, body, principal);
  }

  @Post('vehicles/:id/seat-map')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.FLEET_MANAGE, PERMISSIONS.SEATMAP_READ)
  @ApiOkResponse({ description: 'Seat map assigned, replaced or removed, and audited.' })
  @ApiConflictResponse({
    type: ErrorBody,
    description: 'VEHICLE_RETIRED or VEHICLE_SEAT_MAP_CONFLICT',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description: 'SEAT_MAP_VERSION_NOT_PUBLISHED, SEAT_MAP_VERSION_RETIRED or SEAT_MAP_INACTIVE',
  })
  @ApiBody({ type: VehicleSeatMapBody })
  assignSeatMap(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(vehicleSeatMapSchema)) body: z.infer<typeof vehicleSeatMapSchema>,
  ) {
    return this.fleet.assignSeatMap(id, body, principal);
  }
}
