import { Body, Controller, Get, Header, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import { RATE_LIMITS } from '../auth/rate-limit/rate-limit.rules.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { checkInSchema, seatAssignmentSchema } from './check-in.dto.js';
import { CheckInService } from './check-in.service.js';
import { customerCheckInView } from './check-in-views.js';

const SUBJECT = 'bookings/:bookingReference/passengers/:passengerReference';

@ApiTags('booking: check-in')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Origin or CSRF token invalid' })
@Controller({ path: 'booking', version: '1' })
@AuthRealmRoute('customer')
@UseGuards(AuthRequestGuard, SessionGuard)
export class CustomerCheckInController {
  constructor(private readonly checkIns: CheckInService) {}

  @Get('bookings/:bookingReference/check-in')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Seats, readiness and check-ins of an owned booking.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  booking(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
  ) {
    return this.checkIns.customerBooking(principal, bookingReference);
  }

  @Get(`${SUBJECT}/check-in-readiness`)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Six server-derived gates and blockers; no side effect.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  async readiness(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
    @Param('passengerReference') passengerReference: string,
  ) {
    const subject = await this.checkIns.subject(
      bookingReference,
      passengerReference,
      principal.identityId,
    );
    return this.checkIns.readiness(subject);
  }

  @Post(`${SUBJECT}/seat`)
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Links the traveller to one seat already booked.' })
  @ApiConflictResponse({ type: ErrorBody })
  async assignSeat(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
    @Param('passengerReference') passengerReference: string,
    @Body(new ZodValidationPipe(seatAssignmentSchema))
    body: z.infer<typeof seatAssignmentSchema>,
  ) {
    const subject = await this.checkIns.subject(
      bookingReference,
      passengerReference,
      principal.identityId,
    );
    return this.checkIns.assignSeat(
      principal,
      subject,
      body.seatLabel,
      RATE_LIMITS.checkInCustomerIdentity,
    );
  }

  @Post(`${SUBJECT}/check-in`)
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'The one check-in, only when every gate passes.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'CHECK_IN_NOT_READY with blockers' })
  async checkIn(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
    @Param('passengerReference') passengerReference: string,
    @Body(new ZodValidationPipe(checkInSchema)) _body: z.infer<typeof checkInSchema>,
  ) {
    const subject = await this.checkIns.subject(
      bookingReference,
      passengerReference,
      principal.identityId,
    );
    const { created, row } = await this.checkIns.checkIn(
      principal,
      subject,
      RATE_LIMITS.checkInCustomerIdentity,
    );
    return { created, checkIn: customerCheckInView(row) };
  }

  @Get('check-ins/:reference/qr')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOkResponse({ description: 'Locally generated PII-free boarding QR of an owned check-in.' })
  qr(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.checkIns.customerCheckInQr(principal, reference);
  }
}
