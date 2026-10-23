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
import { cargoQuoteTransitionSchema } from './cargo-quote.dto.js';
import {
  customerCargoCreateSchema,
  customerCargoListQuerySchema,
} from './cargo.dto.js';
import { CustomerCargoService } from './customer-cargo.service.js';

@ApiTags('booking: cargo')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Origin or CSRF token invalid' })
@Controller({ path: 'booking/cargo', version: '1' })
@AuthRealmRoute('customer')
@UseGuards(AuthRequestGuard, SessionGuard)
export class CustomerCargoController {
  constructor(private readonly cargo: CustomerCargoService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Road-freight requests owned by the authenticated CUSTOMER.' })
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(customerCargoListQuerySchema))
    query: z.infer<typeof customerCargoListQuerySchema>,
  ) {
    return this.cargo.list(principal, query);
  }

  @Post()
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({
    description: 'Creates a QUOTE-state freight request owned by the authenticated CUSTOMER.',
  })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(customerCargoCreateSchema))
    body: z.infer<typeof customerCargoCreateSchema>,
  ) {
    return this.cargo.create(principal, body);
  }

  @Get(':reference/quotes')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description: 'Commercial quotes actually issued for an owned freight request.',
  })
  @ApiNotFoundResponse({ type: ErrorBody })
  quotes(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
  ) {
    return this.cargo.quotes(principal, reference);
  }

  @Post(':reference/quotes/:quoteReference/accept')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description: 'Accepts an owned ISSUED freight quote without creating payment.',
  })
  @ApiNotFoundResponse({ type: ErrorBody })
  acceptQuote(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Param('quoteReference') quoteReference: string,
    @Body(new ZodValidationPipe(cargoQuoteTransitionSchema))
    body: z.infer<typeof cargoQuoteTransitionSchema>,
  ) {
    return this.cargo.acceptQuote(principal, reference, quoteReference, body);
  }

  @Get(':reference')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'One owned freight request with privacy-bounded tracking.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  detail(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.cargo.detail(principal, reference);
  }
}
