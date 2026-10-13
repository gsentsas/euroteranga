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
  TripCancelBody,
  TripCreateBody,
  TripTimetableBody,
  TripVehicleBody,
  tripCancelSchema,
  tripCreateSchema,
  tripListQuerySchema,
  tripScheduleSchema,
  tripTimetableSchema,
  tripVehicleSchema,
} from './trip.dto.js';
import { TripService } from './trip.service.js';

const uuidV7 = new ParseUUIDPipe({ version: '7' });

/**
 * STAFF administration of trips. Every endpoint requires ops.access; reads
 * add trip.read, mutations trip.manage and a session-bound CSRF token. There
 * is no delete endpoint: trips are cancelled.
 */
@ApiTags('admin: trips')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/trips', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminTripController {
  constructor(private readonly trips: TripService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TRIP_READ)
  @ApiOkResponse({ description: 'Trips, newest first, using UUIDv7 keyset pagination.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'SCHEDULED', 'CANCELLED'] })
  @ApiQuery({ name: 'routeId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'routeVersionId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'departureFrom', required: false, type: String, format: 'date-time' })
  @ApiQuery({ name: 'departureTo', required: false, type: String, format: 'date-time' })
  list(
    @Query(new ZodValidationPipe(tripListQuerySchema)) query: z.infer<typeof tripListQuerySchema>,
  ) {
    return this.trips.listTrips(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.TRIP_READ)
  @ApiOkResponse({ description: 'Trip with route geometry, timetable, vehicle and history.' })
  trip(@Param('id', uuidV7) id: string) {
    return this.trips.trip(id);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.TRIP_MANAGE)
  @ApiCreatedResponse({ description: 'Trip created as DRAFT and audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'TRIP_REFERENCE_CONFLICT' })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description:
      'TRIP_ROUTE_VERSION_NOT_PUBLISHED, TRIP_ROUTE_VERSION_RETIRED or TRIP_VEHICLE_UNAVAILABLE',
  })
  @ApiBody({ type: TripCreateBody })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(tripCreateSchema)) body: z.infer<typeof tripCreateSchema>,
  ) {
    return this.trips.createTrip(body, principal);
  }

  @Post(':id/timetable')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.TRIP_MANAGE)
  @ApiOkResponse({ description: 'Complete DRAFT timetable replaced atomically and audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'TRIP_NOT_DRAFT' })
  @ApiUnprocessableEntityResponse({ type: ErrorBody, description: 'TRIP_TIMETABLE_INVALID' })
  @ApiBody({ type: TripTimetableBody })
  timetable(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(tripTimetableSchema)) body: z.infer<typeof tripTimetableSchema>,
  ) {
    return this.trips.replaceTimetable(id, body, principal);
  }

  @Post(':id/schedule')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.TRIP_MANAGE)
  @ApiOkResponse({ description: 'DRAFT -> SCHEDULED; the timetable is frozen.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'TRIP_NOT_DRAFT or TRIP_CANCELLED' })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description: 'TRIP_TIMETABLE_INVALID or TRIP_VEHICLE_UNAVAILABLE',
  })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  schedule(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(tripScheduleSchema)) _body: Record<string, never>,
  ) {
    return this.trips.schedule(id, principal);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.TRIP_MANAGE)
  @ApiOkResponse({ description: 'Trip cancelled (terminal) with its reason.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'TRIP_CANCELLED or TRIP_STATUS_CONFLICT' })
  @ApiBody({ type: TripCancelBody })
  cancel(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(tripCancelSchema)) body: z.infer<typeof tripCancelSchema>,
  ) {
    return this.trips.cancel(id, body, principal);
  }

  @Post(':id/vehicle')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.TRIP_MANAGE)
  @ApiOkResponse({ description: 'Vehicle assigned, changed or removed, and audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'TRIP_CANCELLED or TRIP_VEHICLE_CONFLICT' })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description: 'TRIP_VEHICLE_UNAVAILABLE or TRIP_REASON_REQUIRED',
  })
  @ApiBody({ type: TripVehicleBody })
  vehicle(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(tripVehicleSchema)) body: z.infer<typeof tripVehicleSchema>,
  ) {
    return this.trips.assignVehicle(id, body, principal);
  }
}
