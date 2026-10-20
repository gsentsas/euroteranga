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
import type { PayPalGateway } from './payments/providers/paypal-payment.provider.js';
import type { StripeGateway } from './payments/providers/stripe-payment.provider.js';
import type { PaymentProvider } from './payments/providers/payment-provider.js';
import type { WaveGateway } from './payments/providers/wave-payment.provider.js';
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
  /** Test-only Stripe API override (CI never reaches Stripe); production uses the SDK. */
  stripeGateway?: StripeGateway;
  /** Test-only PayPal API override (CI never reaches PayPal); production uses the SDK. */
  paypalGateway?: PayPalGateway;
  /** Test-only Wave HTTP override (CI never reaches Wave). */
  waveGateway?: WaveGateway;
  /** Test-only complete provider overrides; production passes none. */
  testPaymentProviders?: readonly PaymentProvider[];
}

export async function createApp(options: CreateAppOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(options), {
    logger: new NestJsonLogger(options.logger),
    // Surface bootstrap errors to the caller instead of exiting the process.
    abortOnError: false,
    // Register the JSON parser ourselves after request-id middleware so parser
    // failures still receive a request id. rawBody keeps the exact webhook bytes.
    bodyParser: false,
    rawBody: true,
  });
  configureApp(app, options);
  return app;
}

function configureApp(app: NestExpressApplication, { env, logger }: CreateAppOptions): void {
  app.disable('x-powered-by');
  // X-Forwarded-For is ignored unless a proxy is explicitly trusted.
  app.set('trust proxy', env.API_TRUST_PROXY === 'loopback' ? 'loopback' : false);

  // First middleware: parser failures included. Keep this before useBodyParser
  // so malformed/oversized JSON still receives and logs a stable request id.
  app.use(requestIdMiddleware(logger));
  // Nest's useBodyParser respects the application's rawBody option, so signed
  // payment webhooks keep their exact bytes.
  app.useBodyParser('json', { limit: '32kb' });
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
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id', 'Idempotency-Key'],
    // Document filenames are server-generated public references; no object key
    // or signed URL is exposed.
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'Content-Disposition'],
  });

  // Business endpoints will live under /v1/...; health checks are version neutral.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalFilters(new FoundationExceptionFilter(logger));

  if (env.OPENAPI_ENABLED) {
    SwaggerModule.setup('docs', app, () => createOpenApiDocument(app));
  }
}
