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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiQuery,
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
import { adminBookingListQuerySchema, StaffCancelBody, staffCancelSchema } from './booking.dto.js';
import { BookingService } from './booking.service.js';

const uuidV7 = new ParseUUIDPipe({ version: '7' });

/**
 * STAFF administration of customer holds: reads need booking.read, a
 * cancellation needs booking.manage, a reason and a CSRF token. No creation
 * and no deletion: holds are created by customers and only cancelled here.
 */
@ApiTags('admin: bookings')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/bookings', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminBookingController {
  constructor(private readonly bookings: BookingService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.BOOKING_READ)
  @ApiOkResponse({ description: 'Bookings, newest first (UUIDv7 keyset), derived status.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'status', required: false, enum: ['HELD', 'EXPIRED', 'CANCELLED'] })
  @ApiQuery({ name: 'tripId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'reference', required: false, type: String })
  list(
    @Query(new ZodValidationPipe(adminBookingListQuerySchema))
    query: z.infer<typeof adminBookingListQuerySchema>,
  ) {
    return this.bookings.adminBookings(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.BOOKING_READ)
  @ApiOkResponse({ description: 'Booking with its journey, seats and amounts.' })
  detail(@Param('id', uuidV7) id: string) {
    return this.bookings.adminBooking(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.BOOKING_MANAGE)
  @ApiOkResponse({ description: 'Active hold cancelled with its reason, audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'BOOKING_CANCELLED or BOOKING_EXPIRED' })
  @ApiBody({ type: StaffCancelBody })
  cancel(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(staffCancelSchema)) body: z.infer<typeof staffCancelSchema>,
  ) {
    return this.bookings.cancelByStaff(principal, id, body.reason);
  }
}
