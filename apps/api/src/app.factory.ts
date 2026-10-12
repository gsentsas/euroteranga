import type { ApiEnv } from '@euroteranga/config';
import type { Logger } from '@euroteranga/logger';
import { VersioningType, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { buildAuthConfig } from './auth/auth.config.js';
import type { AuthMailProvider } from './auth/mail/auth-mail.provider.js';
import { FoundationExceptionFilter } from './common/exception.filter.js';
import { NestJsonLogger } from './common/logging.js';
import { requestIdMiddleware } from './common/request-id.js';
import { createOpenApiDocument } from './openapi.js';

export interface CreateAppOptions {
  env: ApiEnv;
  logger: Logger;
  /** Test-only controllers; production code never passes any. */
  extraControllers?: Type<unknown>[];
  /** Test-only mail transport override; production uses the configured one. */
  mailProvider?: AuthMailProvider;
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
  // X-Forwarded-For is ignored unless a proxy is explicitly trusted.
  app.set('trust proxy', env.API_TRUST_PROXY === 'loopback' ? 'loopback' : false);
  app.useBodyParser('json', { limit: '32kb' });

  // First middleware: every later log line and error response carries the id.
  app.use(requestIdMiddleware(logger));
  app.use(helmet());

  // Authentication responses (sessions, CSRF tokens, MFA secrets) are never cached.
  app.use(
    '/v1/auth',
    (
      _request: unknown,
      response: { setHeader(name: string, value: string): void },
      next: () => void,
    ) => {
      response.setHeader('Cache-Control', 'no-store');
      next();
    },
  );

  // Credentialed CORS for exact origins only (configuration rejects "*").
  // Which realm an origin may use is enforced per route by AuthRequestGuard.
  app.enableCors({
    origin: [...buildAuthConfig(env).corsOrigins],
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });

  // Business endpoints will live under /v1/...; health checks are version neutral.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalFilters(new FoundationExceptionFilter(logger));

  if (env.OPENAPI_ENABLED) {
    SwaggerModule.setup('docs', app, () => createOpenApiDocument(app));
  }
}
