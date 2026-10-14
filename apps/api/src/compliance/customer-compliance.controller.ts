import { Controller, Get, Header, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { ComplianceEvaluationService } from './compliance-evaluation.service.js';

/**
 * CUSTOMER view of the compliance of their own booking passengers. Foreign
 * and unknown references are the same 404. Reading has no side effect;
 * evaluating is an explicit, rate-limited, deduplicated POST.
 */
@ApiTags('booking: passenger compliance')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Origin or CSRF token invalid' })
@Controller({ path: 'booking', version: '1' })
@AuthRealmRoute('customer')
@UseGuards(AuthRequestGuard, SessionGuard)
export class CustomerComplianceController {
  constructor(private readonly compliance: ComplianceEvaluationService) {}

  @Get('bookings/:bookingReference/compliance')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description:
      'Current compliance status per passenger of an owned booking. TECHNICALLY_ACCEPTED != REGULATORY_VALID.',
  })
  @ApiNotFoundResponse({ type: ErrorBody })
  summary(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
  ) {
    return this.compliance.customerSummary(principal, bookingReference);
  }

  @Post('bookings/:bookingReference/passengers/:passengerReference/compliance-evaluations')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description: 'Evaluated from server-side facts (deduplicated when nothing changed).',
  })
  @ApiNotFoundResponse({ type: ErrorBody })
  @ApiTooManyRequestsResponse({ type: ErrorBody })
  evaluate(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
    @Param('passengerReference') passengerReference: string,
  ) {
    return this.compliance.customerEvaluate(principal, bookingReference, passengerReference);
  }
}
