import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuthorizationGuard, RequirePermissions } from '../authorization/authorization.guard.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import {
  ContentArchiveBody,
  ContentCreateBody,
  ContentDraftBody,
  ContentExpectedDraftBody,
  ContentRestoreBody,
  contentArchiveSchema,
  contentCreateSchema,
  contentDiscardSchema,
  contentDraftSchema,
  contentListQuerySchema,
  contentPublishSchema,
  contentRestoreSchema,
} from './content.dto.js';
import { ContentService, type ContentCaller } from './content.service.js';

const uuidV7 = new ParseUUIDPipe({ version: '7' });

/**
 * CMS-1 STAFF administration of the public website content. Every endpoint
 * requires ops.access and content.read; mutations add content.manage and a
 * session-bound CSRF token. Changing the search metadata of a page also
 * requires seo.manage (checked against the current draft or live revision).
 * There is no delete: drafts are discarded, pages archived, history kept.
 */
@ApiTags('admin: content')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/content', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS, PERMISSIONS.CONTENT_READ)
export class AdminContentController {
  constructor(
    private readonly content: ContentService,
    private readonly authorization: AuthorizationService,
  ) {}

  /** seo.manage is read before any work, so a refused change writes nothing. */
  private async caller(principal: AuthPrincipal): Promise<ContentCaller> {
    return {
      actor: principal,
      canManageSeo: await this.authorization.hasAll(principal.identityId, [PERMISSIONS.SEO_MANAGE]),
    };
  }

  @Get('entries')
  @ApiOkResponse({
    description: 'Entries, newest first (UUIDv7 keyset), with draft and live summaries.',
  })
  @ApiQuery({ name: 'kind', required: false, enum: ['PAGE', 'SITE_SETTINGS', 'NAVIGATION'] })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  list(
    @Query(new ZodValidationPipe(contentListQuerySchema))
    query: z.infer<typeof contentListQuerySchema>,
  ) {
    return this.content.list(query);
  }

  @Get('entries/:id')
  @ApiOkResponse({ description: 'Entry with its draft, live revision and the last 30 revisions.' })
  entry(@Param('id', uuidV7) id: string) {
    return this.content.entry(id);
  }

  @Get('entries/:id/revisions/:revision')
  @ApiOkResponse({ description: 'One revision with its full document (history, preview).' })
  revision(@Param('id', uuidV7) id: string, @Param('revision', ParseIntPipe) revision: number) {
    return this.content.revision(id, revision);
  }

  @Post('entries')
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @ApiCreatedResponse({
    description:
      'A page (draft, not indexable until seo.manage opens it) or a singleton from the default content.',
  })
  @ApiConflictResponse({
    type: ErrorBody,
    description: 'CONTENT_PATH_TAKEN or CONTENT_SINGLETON_EXISTS',
  })
  @ApiBody({ type: ContentCreateBody })
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(contentCreateSchema)) body: z.infer<typeof contentCreateSchema>,
  ) {
    return this.content.create(body, principal);
  }

  @Post('entries/:id/draft')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @ApiOkResponse({ description: 'Draft created or replaced (the live revision is untouched).' })
  @ApiConflictResponse({ type: ErrorBody, description: 'CONTENT_DRAFT_CONFLICT' })
  @ApiUnprocessableEntityResponse({ type: ErrorBody, description: 'CONTENT_DOCUMENT_INVALID' })
  @ApiBody({ type: ContentDraftBody })
  async saveDraft(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(contentDraftSchema)) body: z.infer<typeof contentDraftSchema>,
  ) {
    return this.content.saveDraft(id, body, await this.caller(principal));
  }

  @Post('entries/:id/publish')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @ApiOkResponse({
    description: 'The draft becomes live; the previous live revision is kept as history.',
  })
  @ApiConflictResponse({
    type: ErrorBody,
    description: 'CONTENT_NO_DRAFT or CONTENT_DRAFT_CONFLICT',
  })
  @ApiBody({ type: ContentExpectedDraftBody })
  publish(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(contentPublishSchema)) body: z.infer<typeof contentPublishSchema>,
  ) {
    return this.content.publish(id, body, principal);
  }

  @Post('entries/:id/discard-draft')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @ApiOkResponse({ description: 'The draft is discarded; the live revision is untouched.' })
  @ApiBody({ type: ContentExpectedDraftBody })
  discard(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(contentDiscardSchema)) body: z.infer<typeof contentDiscardSchema>,
  ) {
    return this.content.discardDraft(id, body, principal);
  }

  @Post('entries/:id/restore')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @ApiOkResponse({ description: 'A new draft copied from an earlier revision.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'CONTENT_DRAFT_EXISTS' })
  @ApiBody({ type: ContentRestoreBody })
  async restore(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(contentRestoreSchema)) body: z.infer<typeof contentRestoreSchema>,
  ) {
    return this.content.restore(id, body, await this.caller(principal));
  }

  @Post('entries/:id/archive')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @ApiOkResponse({ description: 'The page is no longer served (history kept).' })
  @ApiUnprocessableEntityResponse({ type: ErrorBody, description: 'CONTENT_ARCHIVE_FORBIDDEN' })
  @ApiBody({ type: ContentArchiveBody })
  archive(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(contentArchiveSchema)) body: z.infer<typeof contentArchiveSchema>,
  ) {
    return this.content.archive(id, body, principal);
  }

  @Post('entries/:id/unarchive')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.CONTENT_MANAGE)
  @ApiOkResponse({ description: 'The page is served again with its live revision.' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  unarchive(@Param('id', uuidV7) id: string, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.content.unarchive(id, principal);
  }
}
