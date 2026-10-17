import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConsumes,
  ApiForbiddenResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import {
  AuthRequestGuard,
  CsrfGuard,
  MultipartRoute,
  SessionGuard,
} from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import {
  expenseCreateSchema,
  expenseReferenceSchema,
  financeReceiptIdSchema,
  financeVoidSchema,
  paymentReferenceSchema,
  payoutCreateSchema,
  refundCreateSchema,
  revenueCreateSchema,
  revenueReferenceSchema,
  tripFinanceReferenceSchema,
} from './finance.dto.js';
import { financeCsv, financeXlsx } from './finance-export.js';
import { FinanceService } from './finance.service.js';

@ApiTags('admin: finance')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'admin/finance', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
export class AdminFinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('trips/:tripReference')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  summary(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripReference', new ZodValidationPipe(tripFinanceReferenceSchema))
    tripReference: string,
  ) {
    return this.finance.tripSummary(actor, tripReference);
  }

  @Post('trips/:tripReference/revenues')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  createRevenue(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripReference', new ZodValidationPipe(tripFinanceReferenceSchema))
    tripReference: string,
    @Body(new ZodValidationPipe(revenueCreateSchema)) body: z.infer<typeof revenueCreateSchema>,
  ) {
    return this.finance.createRevenue(actor, tripReference, body);
  }

  @Post('trips/:tripReference/expenses')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  createExpense(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripReference', new ZodValidationPipe(tripFinanceReferenceSchema))
    tripReference: string,
    @Body(new ZodValidationPipe(expenseCreateSchema)) body: z.infer<typeof expenseCreateSchema>,
  ) {
    return this.finance.createExpense(actor, tripReference, body);
  }

  @Post('revenues/:reference/void')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  voidRevenue(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('reference', new ZodValidationPipe(revenueReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(financeVoidSchema)) body: z.infer<typeof financeVoidSchema>,
  ) {
    return this.finance.voidRevenue(actor, reference, body);
  }

  @Post('expenses/:reference/void')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  voidExpense(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('reference', new ZodValidationPipe(expenseReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(financeVoidSchema)) body: z.infer<typeof financeVoidSchema>,
  ) {
    return this.finance.voidExpense(actor, reference, body);
  }

  @Post('payments/:paymentReference/refunds')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.PAYMENT_REFUND)
  refund(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('paymentReference', new ZodValidationPipe(paymentReferenceSchema))
    paymentReference: string,
    @Body(new ZodValidationPipe(refundCreateSchema)) body: z.infer<typeof refundCreateSchema>,
  ) {
    return this.finance.refundPayment(actor, paymentReference, body);
  }

  @Post('expenses/:reference/payouts')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  payout(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('reference', new ZodValidationPipe(expenseReferenceSchema)) reference: string,
    @Body(new ZodValidationPipe(payoutCreateSchema)) body: z.infer<typeof payoutCreateSchema>,
  ) {
    return this.finance.recordPayout(actor, reference, body);
  }

  @Post('expenses/:reference/receipts')
  @MultipartRoute()
  @ApiConsumes('multipart/form-data')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  receipt(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('reference', new ZodValidationPipe(expenseReferenceSchema)) reference: string,
    @Req() request: Request,
  ) {
    return this.finance.uploadReceipt(actor, reference, request);
  }

  @Get('expenses/:reference/receipts/:receiptId/download')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  async downloadReceipt(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('reference', new ZodValidationPipe(expenseReferenceSchema)) reference: string,
    @Param('receiptId', new ZodValidationPipe(financeReceiptIdSchema)) receiptId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { receipt, stored } = await this.finance.downloadReceipt(actor, reference, receiptId);
    const extension =
      receipt.mimeType === 'application/pdf'
        ? 'pdf'
        : receipt.mimeType === 'image/jpeg'
          ? 'jpg'
          : 'png';
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', receipt.mimeType);
    response.setHeader('Content-Length', String(stored.sizeBytes));
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="' + receipt.reference + '.' + extension + '"',
    );
    return new StreamableFile(stored.body);
  }

  @Get('trips/:tripReference/export.csv')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  async csv(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripReference', new ZodValidationPipe(tripFinanceReferenceSchema))
    tripReference: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const summary = await this.finance.tripSummary(actor, tripReference);
    const body = financeCsv(summary);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="' + tripReference + '-finance.csv"',
    );
    response.setHeader('Content-Length', String(body.length));
    return new StreamableFile(body);
  }

  @Get('trips/:tripReference/export.xlsx')
  @RequirePermissions(PERMISSIONS.FINANCE_READ)
  async xlsx(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Param('tripReference', new ZodValidationPipe(tripFinanceReferenceSchema))
    tripReference: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const summary = await this.finance.tripSummary(actor, tripReference);
    const body = financeXlsx(summary);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="' + tripReference + '-finance.xlsx"',
    );
    response.setHeader('Content-Length', String(body.length));
    return new StreamableFile(body);
  }
}
