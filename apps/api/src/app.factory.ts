import type { ApiEnv } from '@euroteranga/config';
import type { Logger } from '@euroteranga/logger';
import { VersioningType, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { FoundationExceptionFilter } from './common/exception.filter.js';
import { NestJsonLogger } from './common/logging.js';
import { requestIdMiddleware } from './common/request-id.js';
import { createOpenApiDocument } from './openapi.js';

export interface CreateAppOptions {
  env: ApiEnv;
  logger: Logger;
  /** Test-only controllers; production code never passes any. */
  extraControllers?: Type<unknown>[];
}

export async function createApp(options: CreateAppOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(options), {
    logger: new NestJsonLogger(options.logger),
    // Surface bootstrap errors to the caller instead of exiting the process.
    abortOnError: false,
  });
  configureApp(app, options);
  return app;
}

function configureApp(app: NestExpressApplication, { env, logger }: CreateAppOptions): void {
  app.disable('x-powered-by');

  // First middleware: every later log line and error response carries the id.
  app.use(requestIdMiddleware(logger));
  app.use(helmet());

  // Explicit allow-list only. Credentials stay disabled until authentication
  // exists and its cookie strategy is decided.
  app.enableCors({
    origin: env.API_CORS_ORIGINS,
    credentials: false,
    exposedHeaders: ['X-Request-Id'],
  });

  // Business endpoints will live under /v1/...; health checks are version neutral.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalFilters(new FoundationExceptionFilter(logger));

  if (env.OPENAPI_ENABLED) {
    SwaggerModule.setup('docs', app, () => createOpenApiDocument(app));
  }
}
