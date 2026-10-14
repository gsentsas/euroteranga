import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { adminDocumentListQuerySchema } from './passenger-document.dto.js';
import { downloadFilename } from './passenger-document-rules.js';
import { PassengerDocumentService } from './passenger-document.service.js';

@ApiTags('admin: passenger documents')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'passenger.document.read is required' })
@Controller({ path: 'admin/passenger-documents', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS, PERMISSIONS.PASSENGER_DOCUMENT_READ)
export class AdminPassengerDocumentController {
  constructor(private readonly documents: PassengerDocumentService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description: 'Paginated passenger document metadata, never object bytes; each page is audited.',
  })
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(adminDocumentListQuerySchema))
    query: z.infer<typeof adminDocumentListQuerySchema>,
  ) {
    return this.documents.adminDocuments(principal, query);
  }

  @Get(':reference')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Sensitive document metadata; the read is audited.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  detail(@CurrentPrincipal() principal: AuthPrincipal, @Param('reference') reference: string) {
    return this.documents.adminDocument(principal, reference);
  }

  @Get(':reference/download')
  @ApiOkResponse({ description: 'Permissioned private stream of an ACCEPTED file.' })
  @ApiNotFoundResponse({ type: ErrorBody })
  async download(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('reference') reference: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { document, stored } = await this.documents.adminDownload(principal, reference);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', document.mimeType);
    response.setHeader('Content-Length', String(stored.sizeBytes));
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${downloadFilename(document.reference, document.mimeType)}"`,
    );
    return new StreamableFile(stored.body);
  }
}
