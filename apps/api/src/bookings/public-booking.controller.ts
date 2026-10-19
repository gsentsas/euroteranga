import { Controller, Get, Header, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import {
  availabilityQuerySchema,
  bookingSearchQuerySchema,
  publicStopsQuerySchema,
} from './booking.dto.js';
import { PublicBookingService } from './public-booking.service.js';

/**
 * Public booking reads: no session. They expose only what a traveller needs
 * to choose a trip and seats; creating a hold requires a CUSTOMER session.
 */
@ApiTags('booking: public')
@Controller({ path: 'booking', version: '1' })
export class PublicBookingController {
  constructor(private readonly booking: PublicBookingService) {}

  @Get('stops')
  @ApiOkResponse({ description: 'Active stops (id, code, name, locality, timezone, country).' })
  @ApiQuery({ name: 'query', required: false, type: String, maxLength: 64 })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 50 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  stops(
    @Query(new ZodValidationPipe(publicStopsQuerySchema))
    query: z.infer<typeof publicStopsQuerySchema>,
  ) {
    return this.booking.stops(query);
  }

  @Get('trips')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description:
      'Bookable journeys for an origin/destination stop pair, by origin departure time (keyset).',
  })
  @ApiQuery({ name: 'originStopId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'destinationStopId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'departureFrom', required: false, type: String, format: 'date-time' })
  @ApiQuery({ name: 'departureTo', required: false, type: String, format: 'date-time' })
  @ApiQuery({ name: 'minAvailableSeats', required: false, type: Number, minimum: 1, maximum: 20 })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 50 })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  search(
    @Query(new ZodValidationPipe(bookingSearchQuerySchema))
    query: z.infer<typeof bookingSearchQuerySchema>,
  ) {
    return this.booking.search(query);
  }

  @Get('trips/:tripId/itinerary')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOkResponse({
    description:
      'UI-PUBLIC-2: planned stops and crossings of a bookable trip (never its technical checkpoints), their planned times, and the assigned vehicle (public facts) while active.',
  })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'BOOKING_TRIP_NOT_BOOKABLE' })
  itinerary(@Param('tripId', new ParseUUIDPipe({ version: '7' })) tripId: string) {
    return this.booking.itinerary(tripId);
  }

  @Get('trips/:tripId/availability')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description: 'Historical seat map of the trip, seat availability for the journey, exact fare.',
  })
  @ApiNotFoundResponse({
    type: ErrorBody,
    description: 'BOOKING_TRIP_NOT_BOOKABLE or BOOKING_FARE_NOT_CONFIGURED',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description:
      'BOOKING_TRIP_DEPARTED, BOOKING_SEAT_MAP_NOT_CONFIGURED, BOOKING_PRICING_NOT_CONFIGURED or BOOKING_OD_INVALID',
  })
  @ApiQuery({ name: 'originRouteWaypointId', required: true, type: String, format: 'uuid' })
  @ApiQuery({ name: 'destinationRouteWaypointId', required: true, type: String, format: 'uuid' })
  availability(
    @Param('tripId', new ParseUUIDPipe({ version: '7' })) tripId: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema))
    query: z.infer<typeof availabilityQuerySchema>,
  ) {
    return this.booking.availability(
      tripId,
      query.originRouteWaypointId,
      query.destinationRouteWaypointId,
    );
  }
}
