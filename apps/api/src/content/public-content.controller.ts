import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import { publicPageQuerySchema } from './content.dto.js';
import { ContentService } from './content.service.js';

/**
 * Public, unauthenticated reads of the published website content only:
 * never a draft, an archived page or a history. Short shared caching keeps
 * the website responsive while publications appear within a minute.
 */
@ApiTags('content')
@Controller({ path: 'content', version: '1' })
export class PublicContentController {
  constructor(private readonly content: ContentService) {}

  @Get('pages')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiQuery({ name: 'path', required: true, type: String, example: '/paris-dakar' })
  @ApiOkResponse({ description: 'The live revision of a served page.' })
  @ApiNotFoundResponse({ type: ErrorBody, description: 'CONTENT_PAGE_NOT_FOUND' })
  page(
    @Query(new ZodValidationPipe(publicPageQuerySchema))
    query: z.infer<typeof publicPageQuerySchema>,
  ) {
    return this.content.publishedPage(query.path);
  }

  @Get('site')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOkResponse({ description: 'Live site settings and navigation (null until published).' })
  site() {
    return this.content.publishedSite();
  }

  @Get('sitemap')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOkResponse({ description: 'Served, indexable page paths with their publication date.' })
  sitemap() {
    return this.content.sitemap();
  }
}
