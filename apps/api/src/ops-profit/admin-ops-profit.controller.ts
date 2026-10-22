import { Controller, Get, Header, Param, UseGuards } from '@nestjs/common';
import { ApiForbiddenResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { OpsProfitService } from './ops-profit.service.js';

@ApiTags('admin: ops profit')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'admin/ops-profit', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
export class AdminOpsProfitController {
  constructor(private readonly profit: OpsProfitService) {}

  @Get('trips/:tripReference')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.FINANCE_READ, PERMISSIONS.TRIP_READ)
  trip(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripReference') tripReference: string,
  ) {
    return this.profit.tripProfitability(actor, tripReference);
  }
}
