import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import {
  PaymentCreateBody,
  PaymentQuoteCreateBody,
  paymentCancelSchema,
  paymentCreateSchema,
  paymentOptionsQuerySchema,
  paymentQuoteCreateSchema,
  type PaymentCreate,
  type PaymentQuoteCreate,
} from './payment.dto.js';
import { PaymentService } from './payment.service.js';
import { PaymentQuoteService } from './payment-quote.service.js';

/**
 * Payment options, quotes and attempts of the authenticated CUSTOMER. The
 * client only states intentions (payer country, payment method, which quote
 * to pay): every amount, the currency, the rate and the provider come from
 * the server, and no card, wallet or bank data ever reaches EURO TERANGA.
 * Someone else's booking, quote or payment is indistinguishable from an
 * unknown one (404).
 */
@ApiTags('booking: payments')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Origin not allowed or CSRF token invalid' })
@Controller({ path: 'booking', version: '1' })
@AuthRealmRoute('customer')
@UseGuards(AuthRequestGuard, SessionGuard)
export class CustomerPaymentController {
  constructor(
    private readonly payments: PaymentService,
    private readonly quotes: PaymentQuoteService,
  ) {}

  @Get('bookings/:reference/payment-options')
  @Header('Cache-Control', 'no-store')
  @ApiQuery({ name: 'payerCountry', required: true, description: 'FR, ES, MA, MR or SN' })
  @ApiOkResponse({
    description:
      'Methods of the payer country, each with its availability. Never a provider, priority or configuration detail.',
  })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'BOOKING_NOT_FOUND' })
  @ApiUnprocessableEntityResponse({ type: ErrorBody, description: 'PAYMENT_COUNTRY_UNSUPPORTED' })
  options(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Query(new ZodValidationPipe(paymentOptionsQuerySchema)) query: { payerCountry: string },
  ) {
    return this.quotes.options(principal, reference, query.payerCountry);
  }

  @Post('bookings/:reference/payment-quotes')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({
    description:
      'Immutable quote of the amount to pay in the payer currency; takes no money and confirms nothing.',
  })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'BOOKING_NOT_FOUND' })
  @ApiConflictResponse({
    type: ErrorBody,
    description:
      'PAYMENT_METHOD_UNAVAILABLE, PAYMENT_BOOKING_NOT_PAYABLE, PAYMENT_BOOKING_EXPIRED or PAYMENT_BOOKING_CONFIRMED',
  })
  @ApiUnprocessableEntityResponse({ type: ErrorBody, description: 'PAYMENT_COUNTRY_UNSUPPORTED' })
  @ApiTooManyRequestsResponse({ type: ErrorBody, description: 'PAYMENT_QUOTE_LIMIT_REACHED' })
  @ApiServiceUnavailableResponse({
    type: ErrorBody,
    description: 'PAYMENT_PROVIDER_UNAVAILABLE or PAYMENT_FX_UNAVAILABLE',
  })
  @ApiBody({ type: PaymentQuoteCreateBody })
  createQuote(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(paymentQuoteCreateSchema)) body: PaymentQuoteCreate,
  ) {
    return this.quotes.create(principal, reference, body);
  }

  @Post('bookings/:reference/payments')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: '16-64 characters [A-Za-z0-9_-]: the same key returns the same attempt',
  })
  @ApiCreatedResponse({ description: 'PENDING attempt created and audited (PAYMENT_CREATED).' })
  @ApiOkResponse({ description: 'Same Idempotency-Key: the attempt already created.' })
  @ApiNotFoundResponse({
    type: ErrorBody,
    description: 'BOOKING_NOT_FOUND or PAYMENT_QUOTE_NOT_FOUND',
  })
  @ApiConflictResponse({
    type: ErrorBody,
    description:
      'PAYMENT_BOOKING_NOT_PAYABLE, PAYMENT_BOOKING_EXPIRED, PAYMENT_BOOKING_CONFIRMED, PAYMENT_ALREADY_PENDING, PAYMENT_QUOTE_EXPIRED, PAYMENT_QUOTE_ALREADY_USED or PAYMENT_METHOD_UNAVAILABLE',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorBody,
    description: 'PAYMENT_QUOTE_MISMATCH or PAYMENT_IDEMPOTENCY_KEY_REUSED',
  })
  @ApiServiceUnavailableResponse({ type: ErrorBody, description: 'PAYMENT_PROVIDER_UNAVAILABLE' })
  @ApiBody({ type: PaymentCreateBody })
  async create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(paymentCreateSchema)) body: PaymentCreate,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { replayed, result } = await this.payments.create(
      principal,
      reference,
      idempotencyKey,
      body,
    );
    response.status(replayed ? 200 : 201);
    return result;
  }

  @Get('bookings/:reference/payments')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Attempts of one of the caller’s bookings, newest first.' })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'BOOKING_NOT_FOUND' })
  list(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.payments.customerPayments(principal, reference);
  }

  @Post('payments/:reference/cancel')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'PENDING attempt cancelled; the booking stays HELD.' })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'PAYMENT_NOT_FOUND' })
  @ApiConflictResponse({ type: ErrorBody, description: 'PAYMENT_INVALID_TRANSITION' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  cancel(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(paymentCancelSchema)) _body: Record<string, never>,
  ) {
    return this.payments.cancelByCustomer(principal, reference);
  }
}
