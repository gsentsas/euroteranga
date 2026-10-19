import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
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
  MediaArchiveBody,
  MediaUpdateBody,
  mediaArchiveSchema,
  mediaListQuerySchema,
  mediaUpdateSchema,
} from './media.dto.js';
import { MediaService } from './media.service.js';

const uuidV7 = new ParseUUIDPipe({ version: '7' });

/**
 * MEDIA-1 STAFF administration of the public media library. Every endpoint
 * requires ops.access and media.read; mutations add media.manage and a
 * session-bound CSRF token. No passenger-document permission applies here,
 * and media.* never opens passenger documents. There is no delete and no
 * file replacement: an image is immutable, replacing it means uploading a
 * new one, and archiving an unused image is terminal (no longer served).
 */
@ApiTags('admin: media')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@ApiNotFoundResponse({ type: ErrorBody })
@Controller({ path: 'admin/media', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS, PERMISSIONS.MEDIA_READ)
export class AdminMediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description: 'Images, newest first (UUIDv7 keyset), and whether uploads are enabled.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'ARCHIVED'] })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  list(
    @Query(new ZodValidationPipe(mediaListQuerySchema))
    query: z.infer<typeof mediaListQuerySchema>,
  ) {
    return this.media.list(query);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'One image, its renditions and the contents that use it.' })
  detail(@Param('id', uuidV7) id: string) {
    return this.media.detail(id);
  }

  @Post()
  @MultipartRoute()
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.MEDIA_MANAGE)
  @Header('Cache-Control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({
    description: 'Image decoded, re-encoded to WebP without metadata, stored.',
  })
  @ApiConflictResponse({ type: ErrorBody, description: 'MEDIA_DUPLICATE (details.mediaId)' })
  @ApiPayloadTooLargeResponse({ type: ErrorBody })
  @ApiUnsupportedMediaTypeResponse({ type: ErrorBody, description: 'Only JPEG, PNG and WebP' })
  @ApiUnprocessableEntityResponse({ type: ErrorBody })
  @ApiServiceUnavailableResponse({
    type: ErrorBody,
    description: 'MEDIA_STORAGE_DISABLED or MEDIA_BUSY',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['altText', 'file'],
      properties: {
        altText: { type: 'string', maxLength: 250 },
        caption: { type: 'string', maxLength: 240 },
        credit: { type: 'string', maxLength: 160 },
        focalX: { type: 'integer', minimum: 0, maximum: 100 },
        focalY: { type: 'integer', minimum: 0, maximum: 100 },
        replaces: { type: 'string', format: 'uuid', description: 'Image this one replaces' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  upload(@CurrentPrincipal() principal: AuthPrincipal, @Req() request: Request) {
    return this.media.upload(request, principal);
  }

  @Post(':id')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.MEDIA_MANAGE)
  @ApiOkResponse({ description: 'Alternative text, caption, credit or focal point updated.' })
  @ApiConflictResponse({ type: ErrorBody, description: 'MEDIA_ARCHIVED' })
  @ApiBody({ type: MediaUpdateBody })
  update(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(mediaUpdateSchema)) body: z.infer<typeof mediaUpdateSchema>,
  ) {
    return this.media.update(id, body, principal);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.MEDIA_MANAGE)
  @ApiOkResponse({ description: 'Archived for good: no longer served publicly.' })
  @ApiConflictResponse({
    type: ErrorBody,
    description: 'MEDIA_IN_USE (details.usages) or MEDIA_ARCHIVED',
  })
  @ApiBody({ type: MediaArchiveBody })
  archive(
    @Param('id', uuidV7) id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(mediaArchiveSchema)) body: z.infer<typeof mediaArchiveSchema>,
  ) {
    return this.media.archive(id, body.reason, principal);
  }
}
