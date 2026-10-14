import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
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
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import {
  adminBaggageRegistrationSchema,
  baggageEventSchema,
  baggageListQuerySchema,
  baggageQrResolveSchema,
  baggageScanSchema,
  baggageWeightSchema,
} from './baggage.dto.js';
import { BaggageService } from './baggage.service.js';

@ApiTags('admin: baggage')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'baggage.read is required' })
@Controller({ path: 'admin/baggage', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS, PERMISSIONS.BAGGAGE_READ)
export class AdminBaggageController {
  constructor(private readonly baggage: BaggageService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Bounded, filtered baggage list; the sensitive read is audited.' })
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(baggageListQuerySchema))
    query: z.infer<typeof baggageListQuerySchema>,
  ) {
    return this.baggage.adminList(principal, query);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.BAGGAGE_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'STAFF registration on one existing BookingPassenger.' })
  register(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(adminBaggageRegistrationSchema))
    body: z.infer<typeof adminBaggageRegistrationSchema>,
  ) {
    return this.baggage.adminRegister(principal, body);
  }

  @Post('resolve-qr')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Authenticated lookup of a supported, PII-free QR payload.' })
  resolveQr(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(baggageQrResolveSchema))
    body: z.infer<typeof baggageQrResolveSchema>,
  ) {
    return this.baggage.adminResolveQr(principal, body.qrPayload);
  }

  @Post('scan')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.BAGGAGE_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Idempotent operational event from an authenticated scan.' })
  scan(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(baggageScanSchema))
    body: z.infer<typeof baggageScanSchema>,
  ) {
    return this.baggage.recordScan(principal, body);
  }

  @Get(':reference/qr')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOkResponse({ description: 'Locally generated PII-free QR SVG; access is audited.' })
  qr(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.baggage.adminQr(principal, reference);
  }

  @Post(':reference/weight')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.BAGGAGE_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Exact STAFF-authoritative measured-weight event.' })
  weight(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(baggageWeightSchema))
    body: z.infer<typeof baggageWeightSchema>,
  ) {
    return this.baggage.updateWeight(principal, reference, body);
  }

  @Post(':reference/events')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.BAGGAGE_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Serialized append-only lifecycle or exception event.' })
  event(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(baggageEventSchema))
    body: z.infer<typeof baggageEventSchema>,
  ) {
    return this.baggage.recordOperationalEvent(principal, reference, body);
  }

  @Get(':reference')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Bag, subject, trip, weight and immutable timeline.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  detail(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.baggage.adminBaggage(principal, reference);
  }
}
