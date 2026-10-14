import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiQuery,
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
  adminPaymentListQuerySchema,
  StaffPaymentCancelBody,
  staffPaymentCancelSchema,
} from './payment.dto.js';
import { PaymentService } from './payment.service.js';

const uuidV7 = new ParseUUIDPipe({ version: '7' });

/**
 * STAFF reading of payment attempts (payment.read). The only mutation is
 * giving up a PENDING attempt (payment.manage, reason, CSRF). There is
 * deliberately no "mark paid": SUCCEEDED only comes from a provider event.
 */
@ApiTags('admin: payments')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/payments', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminPaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PAYMENT_READ)
  @ApiOkResponse({ description: 'Payment attempts, newest first (UUIDv7 keyset).' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'bookingReference', required: false, type: String })
  @ApiQuery({ name: 'paymentReference', required: false, type: String })
  list(
    @Query(new ZodValidationPipe(adminPaymentListQuerySchema))
    query: z.infer<typeof adminPaymentListQuerySchema>,
  ) {
    return this.payments.adminPayments(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PAYMENT_READ)
  @ApiOkResponse({ description: 'Attempt with its provider event timeline (no payload).' })
  detail(@Param('id', uuidV7) id: string) {
    return this.payments.adminPayment(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PAYMENT_MANAGE)
  @ApiOkResponse({ description: 'PENDING attempt cancelled with its reason, audited.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'PAYMENT_INVALID_TRANSITION' })
  @ApiBody({ type: StaffPaymentCancelBody })
  cancel(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(staffPaymentCancelSchema))
    body: z.infer<typeof staffPaymentCancelSchema>,
  ) {
    return this.payments.cancelByStaff(principal, id, body.reason);
  }
}
