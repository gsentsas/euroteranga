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
  cargoAssignmentSchema,
  cargoCreateSchema,
  cargoEventSchema,
  cargoListQuerySchema,
  cargoUpdateSchema,
} from './cargo.dto.js';
import { CargoService } from './cargo.service.js';

@ApiTags('admin: cargo')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'cargo.read is required' })
@Controller({ path: 'admin/cargo', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS, PERMISSIONS.CARGO_READ)
export class AdminCargoController {
  constructor(private readonly cargo: CargoService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Bounded, filtered road-freight list; access is audited.' })
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(cargoListQuerySchema))
    query: z.infer<typeof cargoListQuerySchema>,
  ) {
    return this.cargo.list(principal, query);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Creates a road-freight record at QUOTE state.' })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(cargoCreateSchema))
    body: z.infer<typeof cargoCreateSchema>,
  ) {
    return this.cargo.create(principal, body);
  }

  @Post(':reference/details')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Updates editable cargo facts before loading.' })
  update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(cargoUpdateSchema))
    body: z.infer<typeof cargoUpdateSchema>,
  ) {
    return this.cargo.update(principal, reference, body);
  }

  @Post(':reference/assignment')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Assigns or reassigns the cargo to one trip vehicle.' })
  assign(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(cargoAssignmentSchema))
    body: z.infer<typeof cargoAssignmentSchema>,
  ) {
    return this.cargo.assign(principal, reference, body);
  }

  @Post(':reference/events')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Serialized append-only lifecycle or exception event.' })
  event(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(cargoEventSchema))
    body: z.infer<typeof cargoEventSchema>,
  ) {
    return this.cargo.recordEvent(principal, reference, body);
  }

  @Get(':reference')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Road-freight detail and immutable operational timeline.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  detail(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.cargo.detail(principal, reference);
  }
}
