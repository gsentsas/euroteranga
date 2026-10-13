import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { paymentCancelSchema, paymentCreateSchema } from './payment.dto.js';
import { PaymentService } from './payment.service.js';

/**
 * Payment attempts of the authenticated CUSTOMER. Only the booking reference
 * is chosen by the client: amount, currency and provider come from the
 * server, and no card or bank data ever reaches EURO TERANGA. Someone else's
 * booking or payment is indistinguishable from an unknown one (404).
 */
@ApiTags('booking: payments')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Origin not allowed or CSRF token invalid' })
@Controller({ path: 'booking', version: '1' })
@AuthRealmRoute('customer')
@UseGuards(AuthRequestGuard, SessionGuard)
export class CustomerPaymentController {
  constructor(private readonly payments: PaymentService) {}

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
  @ApiNotFoundResponse({ type: ErrorBody, description: 'BOOKING_NOT_FOUND' })
  @ApiConflictResponse({
    type: ErrorBody,
    description:
      'PAYMENT_BOOKING_NOT_PAYABLE, PAYMENT_BOOKING_EXPIRED, PAYMENT_BOOKING_CONFIRMED or PAYMENT_ALREADY_PENDING',
  })
  @ApiServiceUnavailableResponse({ type: ErrorBody, description: 'PAYMENT_PROVIDER_UNAVAILABLE' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  async create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(paymentCreateSchema)) _body: Record<string, never>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { replayed, result } = await this.payments.create(principal, reference, idempotencyKey);
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
