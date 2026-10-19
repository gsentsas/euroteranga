import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiNotModifiedResponse,
  ApiOkResponse,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import { MediaErrors } from './media.errors.js';
import { publicMediaQuerySchema, renditionFileSchema } from './media.dto.js';
import { MediaService } from './media.service.js';

/**
 * Public, unauthenticated reads of active images only. Files are WebP
 * renditions re-encoded without metadata, served with a cross-origin
 * resource policy so the website (and the sandboxed OPS preview, whose
 * origin is opaque) can display them. Archived images answer 404.
 */
@ApiTags('media')
@Controller({ path: 'media', version: '1' })
export class PublicMediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  @ApiQuery({
    name: 'ids',
    required: true,
    type: String,
    description: 'Up to 50 comma-separated ids',
  })
  @ApiOkResponse({
    description: 'Active images among the ids (unknown or archived ones are absent).',
  })
  async many(
    @Query(new ZodValidationPipe(publicMediaQuerySchema))
    query: z.infer<typeof publicMediaQuerySchema>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.media.publicMany(query.ids);
    // Set on success only (a @Header decorator would also mark a refused query public).
    response.setHeader('Cache-Control', 'public, max-age=60');
    return result;
  }

  @Get('files/:id/:file')
  @ApiProduces('image/webp')
  @ApiOkResponse({ description: 'One WebP rendition of an active image.' })
  @ApiNotModifiedResponse({ description: 'If-None-Match matches the ETag.' })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'MEDIA_NOT_FOUND' })
  async file(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Param('file') file: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // An error (404, 503) must never be kept by a browser or a proxy: only a
    // served or revalidated file gets the public caching below.
    response.setHeader('Cache-Control', 'no-store');
    const width = renditionFileSchema.safeParse(file);
    if (!width.success) throw MediaErrors.notFound();
    const rendition = await this.media.publicRendition(id, width.data);
    const etag = `"${rendition.sha256}"`;
    const cacheable = () => {
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      // A day of caching: an archived image stops being served within a day.
      response.setHeader('Cache-Control', 'public, max-age=86400');
      response.setHeader('ETag', etag);
    };
    const ifNoneMatch = request.headers['if-none-match'];
    if (ifNoneMatch?.split(',').some((tag) => tag.trim() === etag)) {
      cacheable();
      response.status(304);
      return;
    }
    const stored = await this.media.openRendition(rendition.storageKey);
    cacheable();
    response.setHeader('Content-Type', 'image/webp');
    response.setHeader('Content-Length', String(stored.sizeBytes));
    response.setHeader('Content-Disposition', 'inline');
    return new StreamableFile(stored.body);
  }
}
