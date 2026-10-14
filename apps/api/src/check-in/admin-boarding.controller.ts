import { Body, Controller, Header, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
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
import { BoardingService } from './boarding.service.js';
import { boardingResolveSchema, boardingScanSchema } from './check-in.dto.js';

@ApiTags('admin: boarding')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'boarding.read is required' })
@Controller({ path: 'admin/boarding', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard, CsrfGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS, PERMISSIONS.BOARDING_READ)
export class AdminBoardingController {
  constructor(private readonly boarding: BoardingService) {}

  @Post('resolve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Authenticated lookup of a PII-free boarding QR; audited.' })
  resolve(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(boardingResolveSchema))
    body: z.infer<typeof boardingResolveSchema>,
  ) {
    return this.boarding.resolve(principal, body.qrPayload);
  }

  @Post('scan')
  @RequirePermissions(PERMISSIONS.BOARDING_SCAN)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'One boarding per passenger; every gate re-derived.' })
  @ApiConflictResponse({
    type: ErrorBody,
    description:
      'CHECK_IN_STALE (blockers), PASSENGER_ALREADY_BOARDED, BOARDING_CLIENT_EVENT_ID_REUSED',
  })
  scan(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(boardingScanSchema))
    body: z.infer<typeof boardingScanSchema>,
  ) {
    return this.boarding.scan(principal, body);
  }
}
