import { Controller, Get, Header, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiForbiddenResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { reportingCsv, reportingXlsx } from './reporting-export.js';
import { reportingQuerySchema } from './reporting.dto.js';
import { ReportingService } from './reporting.service.js';

@ApiTags('admin: reporting')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody })
@Controller({ path: 'admin/reporting', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
export class AdminReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get('overview')
  @Header('Cache-Control', 'private, no-store')
  @RequirePermissions(PERMISSIONS.REPORTING_VIEW)
  overview(
    @Query(new ZodValidationPipe(reportingQuerySchema))
    query: z.infer<typeof reportingQuerySchema>,
  ) {
    return this.reporting.overview(query);
  }

  @Get('export.csv')
  @RequirePermissions(PERMISSIONS.REPORTING_EXPORT)
  async csv(
    @Query(new ZodValidationPipe(reportingQuerySchema))
    query: z.infer<typeof reportingQuerySchema>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const overview = await this.reporting.overview(query);
    const body = reportingCsv(overview);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="euro-teranga-reporting.csv"');
    response.setHeader('Content-Length', String(body.length));
    return new StreamableFile(body);
  }

  @Get('export.xlsx')
  @RequirePermissions(PERMISSIONS.REPORTING_EXPORT)
  async xlsx(
    @Query(new ZodValidationPipe(reportingQuerySchema))
    query: z.infer<typeof reportingQuerySchema>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const overview = await this.reporting.overview(query);
    const body = reportingXlsx(overview);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader('Content-Disposition', 'attachment; filename="euro-teranga-reporting.xlsx"');
    response.setHeader('Content-Length', String(body.length));
    return new StreamableFile(body);
  }
}
