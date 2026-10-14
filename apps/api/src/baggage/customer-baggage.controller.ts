import { Body, Controller, Get, Header, Param, Post, UseGuards } from '@nestjs/common';
import {
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
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { baggageRegistrationSchema } from './baggage.dto.js';
import { BaggageService } from './baggage.service.js';

@ApiTags('booking: baggage')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Origin or CSRF token invalid' })
@Controller({ path: 'booking', version: '1' })
@AuthRealmRoute('customer')
@UseGuards(AuthRequestGuard, SessionGuard)
export class CustomerBaggageController {
  constructor(private readonly baggage: BaggageService) {}

  @Post('bookings/:bookingReference/passengers/:passengerReference/baggage')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'One bag registered on an owned confirmed booking.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  register(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
    @Param('passengerReference') passengerReference: string,
    @Body(new ZodValidationPipe(baggageRegistrationSchema))
    body: z.infer<typeof baggageRegistrationSchema>,
  ) {
    return this.baggage.customerRegister(principal, bookingReference, passengerReference, body);
  }

  @Get('bookings/:bookingReference/baggage')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Baggage of one booking owned by the caller.' })
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
  ) {
    return this.baggage.customerBookingBaggage(principal, bookingReference);
  }

  @Get('baggage/:reference/qr')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOkResponse({ description: 'Locally generated PII-free QR SVG for an owned bag.' })
  qr(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.baggage.customerQr(principal, reference);
  }

  @Get('baggage/:reference')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Owned bag and its public event timeline.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  detail(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.baggage.customerBaggage(principal, reference);
  }
}
