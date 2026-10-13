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
  ApiBody,
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
import {
  BookingCreateBody,
  bookingCreateSchema,
  customerBookingListQuerySchema,
  customerCancelSchema,
} from './booking.dto.js';
import { BookingService } from './booking.service.js';

/**
 * Holds of the authenticated CUSTOMER (the booker; no guest booking). The
 * identity always comes from the session, never from the request, and every
 * read or cancellation is scoped to it: someone else's booking is
 * indistinguishable from an unknown one (404 BOOKING_NOT_FOUND).
 */
@ApiTags('booking: customer')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Origin not allowed or CSRF token invalid' })
@Controller({ path: 'booking/bookings', version: '1' })
@AuthRealmRoute('customer')
@UseGuards(AuthRequestGuard, SessionGuard)
export class CustomerBookingController {
  constructor(private readonly bookings: BookingService) {}

  @Post()
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({
    description: 'Provisional hold created (not paid, not a ticket) and audited (BOOKING_HELD).',
  })
  @ApiConflictResponse({ type: ErrorBody, description: 'BOOKING_SEAT_UNAVAILABLE' })
  @ApiNotFoundResponse({
    type: ErrorBody,
    description: 'BOOKING_TRIP_NOT_BOOKABLE or BOOKING_FARE_NOT_CONFIGURED',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description:
      'BOOKING_TRIP_DEPARTED, BOOKING_SEAT_MAP_NOT_CONFIGURED, BOOKING_PRICING_NOT_CONFIGURED, BOOKING_OD_INVALID, BOOKING_SEAT_INVALID or BOOKING_TOO_MANY_SEATS',
  })
  @ApiBody({ type: BookingCreateBody })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(bookingCreateSchema)) body: z.infer<typeof bookingCreateSchema>,
  ) {
    return this.bookings.create(body, principal);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'The caller’s bookings, newest first.' })
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(customerBookingListQuerySchema))
    query: z.infer<typeof customerBookingListQuerySchema>,
  ) {
    return this.bookings.customerBookings(principal, query);
  }

  @Get(':reference')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'One of the caller’s bookings, by public reference.' })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'BOOKING_NOT_FOUND' })
  detail(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.bookings.customerBooking(principal, reference);
  }

  @Post(':reference/cancel')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Active hold cancelled; its seats are available again.' })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'BOOKING_NOT_FOUND' })
  @ApiConflictResponse({ type: ErrorBody, description: 'BOOKING_CANCELLED or BOOKING_EXPIRED' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  cancel(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(customerCancelSchema)) _body: Record<string, never>,
  ) {
    return this.bookings.cancelByCustomer(principal, reference);
  }
}
