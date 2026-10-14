import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
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
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { checkInListQuerySchema, checkInSchema, seatAssignmentSchema } from './check-in.dto.js';
import { CheckInService } from './check-in.service.js';
import { staffCheckInView } from './check-in-views.js';

const SUBJECT = 'bookings/:bookingReference/passengers/:passengerReference';

@ApiTags('admin: check-in')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'checkin.read is required' })
@Controller({ path: 'admin/check-in', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS, PERMISSIONS.CHECKIN_READ)
export class AdminCheckInController {
  constructor(private readonly checkIns: CheckInService) {}

  @Get('booking-passengers')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Bounded, filtered passenger list; each page is audited.' })
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(checkInListQuerySchema))
    query: z.infer<typeof checkInListQuerySchema>,
  ) {
    return this.checkIns.staffList(principal, query);
  }

  @Get(SUBJECT)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Readiness, seats, check-in and boarding; the read is audited.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  async detail(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
    @Param('passengerReference') passengerReference: string,
  ) {
    const subject = await this.checkIns.subject(bookingReference, passengerReference);
    return this.checkIns.staffDetail(principal, subject);
  }

  @Post(`${SUBJECT}/seat`)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CHECKIN_MANAGE)
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
    const subject = await this.checkIns.subject(bookingReference, passengerReference);
    return this.checkIns.assignSeat(
      principal,
      subject,
      body.seatLabel,
      RATE_LIMITS.checkInOperationIdentity,
    );
  }

  @Post(`${SUBJECT}/check-in`)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CHECKIN_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Counter check-in; no gate can be overridden.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'CHECK_IN_NOT_READY with blockers' })
  async checkIn(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('bookingReference') bookingReference: string,
    @Param('passengerReference') passengerReference: string,
    @Body(new ZodValidationPipe(checkInSchema)) _body: z.infer<typeof checkInSchema>,
  ) {
    const subject = await this.checkIns.subject(bookingReference, passengerReference);
    const { created, row } = await this.checkIns.checkIn(
      principal,
      subject,
      RATE_LIMITS.checkInOperationIdentity,
    );
    return { created, checkIn: staffCheckInView(row) };
  }

  @Get('check-ins/:reference/qr')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOkResponse({ description: 'PII-free boarding QR label; access is audited.' })
  qr(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.checkIns.staffCheckInQr(principal, reference);
  }
}
