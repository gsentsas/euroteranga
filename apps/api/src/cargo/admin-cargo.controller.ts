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
  cargoQuoteCancelSchema,
  cargoQuoteCreateSchema,
  cargoQuoteLinesSchema,
  cargoQuoteTransitionSchema,
} from './cargo-quote.dto.js';
import { CargoQuoteService } from './cargo-quote.service.js';
import {
  cargoTrackingTokenCreateSchema,
  cargoTrackingTokenRevokeSchema,
} from './cargo-tracking.dto.js';
import { CargoTrackingService } from './cargo-tracking.service.js';
import {
  cargoAssignmentSchema,
  cargoCreateSchema,
  cargoEventSchema,
  cargoListQuerySchema,
  cargoQrResolveSchema,
  cargoScanSchema,
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
  constructor(
    private readonly cargo: CargoService,
    private readonly quotes: CargoQuoteService,
    private readonly tracking: CargoTrackingService,
  ) {}

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

  @Post('resolve-qr')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Authenticated lookup of a versioned, PII-free Cargo QR.' })
  resolveQr(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(cargoQrResolveSchema))
    body: z.infer<typeof cargoQrResolveSchema>,
  ) {
    return this.cargo.resolveQr(principal, body.qrPayload);
  }

  @Post('scan')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Idempotent Cargo event from a versioned QR scan.' })
  scan(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(cargoScanSchema))
    body: z.infer<typeof cargoScanSchema>,
  ) {
    return this.cargo.recordScan(principal, body);
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
  @HttpCode(200)
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
  @HttpCode(200)
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

  @Get(':reference/quotes')
  @RequirePermissions(PERMISSIONS.PRICING_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Versioned commercial freight quotes.' })
  quotesList(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.quotes.list(principal, reference);
  }

  @Get(':reference/quotes/:quoteReference')
  @RequirePermissions(PERMISSIONS.PRICING_READ)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'One commercial freight quote snapshot.' })
  quoteDetail(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Param('quoteReference') quoteReference: string,
  ) {
    return this.quotes.detail(principal, reference, quoteReference);
  }

  @Post(':reference/quotes')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE, PERMISSIONS.PRICING_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Creates the next DRAFT freight quote version.' })
  quoteCreate(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(cargoQuoteCreateSchema))
    body: z.infer<typeof cargoQuoteCreateSchema>,
  ) {
    return this.quotes.create(principal, reference, body);
  }

  @Post(':reference/quotes/:quoteReference')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE, PERMISSIONS.PRICING_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Atomically replaces all lines of a DRAFT freight quote.' })
  quoteReplaceLines(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Param('quoteReference') quoteReference: string,
    @Body(new ZodValidationPipe(cargoQuoteLinesSchema))
    body: z.infer<typeof cargoQuoteLinesSchema>,
  ) {
    return this.quotes.replaceLines(principal, reference, quoteReference, body);
  }

  @Post(':reference/quotes/:quoteReference/issue')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE, PERMISSIONS.PRICING_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Issues the DRAFT and supersedes any prior ISSUED quote.' })
  quoteIssue(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Param('quoteReference') quoteReference: string,
    @Body(new ZodValidationPipe(cargoQuoteTransitionSchema))
    body: z.infer<typeof cargoQuoteTransitionSchema>,
  ) {
    return this.quotes.issue(principal, reference, quoteReference, body);
  }

  @Post(':reference/quotes/:quoteReference/accept')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE, PERMISSIONS.PRICING_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Accepts an ISSUED quote without triggering payment.' })
  quoteAccept(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Param('quoteReference') quoteReference: string,
    @Body(new ZodValidationPipe(cargoQuoteTransitionSchema))
    body: z.infer<typeof cargoQuoteTransitionSchema>,
  ) {
    return this.quotes.accept(principal, reference, quoteReference, body);
  }

  @Post(':reference/quotes/:quoteReference/cancel')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE, PERMISSIONS.PRICING_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Cancels a DRAFT or ISSUED quote; reason is audited.' })
  quoteCancel(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Param('quoteReference') quoteReference: string,
    @Body(new ZodValidationPipe(cargoQuoteCancelSchema))
    body: z.infer<typeof cargoQuoteCancelSchema>,
  ) {
    return this.quotes.cancel(principal, reference, quoteReference, body);
  }

  @Get(':reference/qr')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOkResponse({ description: 'Locally generated PII-free Cargo QR SVG.' })
  qr(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.cargo.qr(principal, reference);
  }

  @Get(':reference/tracking-tokens')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Cargo public tracking capabilities without token secrets.' })
  trackingTokens(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
  ) {
    return this.tracking.listTokens(principal, reference);
  }

  @Post(':reference/tracking-tokens')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ description: 'Creates one opaque public Cargo tracking link.' })
  trackingTokenCreate(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(cargoTrackingTokenCreateSchema))
    body: z.infer<typeof cargoTrackingTokenCreateSchema>,
  ) {
    return this.tracking.issueToken(principal, reference, body);
  }

  @Post(':reference/tracking-tokens/:tokenId/revoke')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CARGO_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Irreversibly revokes one Cargo public tracking link.' })
  trackingTokenRevoke(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Param('tokenId') tokenId: string,
    @Body(new ZodValidationPipe(cargoTrackingTokenRevokeSchema))
    body: z.infer<typeof cargoTrackingTokenRevokeSchema>,
  ) {
    return this.tracking.revokeToken(principal, reference, tokenId, body);
  }

  @Get(':reference')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Road-freight detail and immutable operational timeline.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  detail(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.cargo.detail(principal, reference);
  }
}
