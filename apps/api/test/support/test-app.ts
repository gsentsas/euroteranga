import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { loadApiEnv, type ApiEnv } from '@euroteranga/config';
import { createLogger, type Logger } from '@euroteranga/logger';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../../src/app.factory.js';
import { FakeAuthMailProvider } from './fake-auth-mail.provider.js';

/** Synthetic origins used by the integration tests. */
export const TEST_ORIGINS = {
  customer: 'http://localhost:3002',
  staff: 'http://localhost:3004',
  crew: 'http://localhost:3005',
} as const;

/** Fresh random key: no static secret-looking value in the repository. */
const randomKey = () => randomBytes(32).toString('base64');

/**
 * Integration tests need a real, disposable PostgreSQL database. They fail
 * loudly rather than silently skipping when none is configured.
 *
 * The loopback proxy is trusted so each test can present its own client
 * address through X-Forwarded-For and keep its rate-limit buckets separate.
 */
export function integrationEnv(overrides: Record<string, string> = {}): ApiEnv {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'Integration tests require DATABASE_URL to point to a disposable PostgreSQL database ' +
        '(see infrastructure/dev/docker-compose.yml).',
    );
  }
  return loadApiEnv({
    NODE_ENV: 'test',
    APP_ENV: 'ci',
    DATABASE_URL: databaseUrl,
    API_CORS_ORIGINS: 'http://localhost:3000',
    API_TRUST_PROXY: 'loopback',
    LOG_LEVEL: 'debug',
    AUTH_CSRF_KEY: randomKey(),
    AUTH_HMAC_KEY: randomKey(),
    AUTH_TOTP_ENCRYPTION_KEY: randomKey(),
    AUTH_CUSTOMER_ORIGINS: TEST_ORIGINS.customer,
    AUTH_STAFF_ORIGINS: TEST_ORIGINS.staff,
    AUTH_CREW_ORIGINS: TEST_ORIGINS.crew,
    AUTH_MAIL_PROVIDER: 'disabled',
    CLIENT_PUBLIC_URL: TEST_ORIGINS.customer,
    OPS_PUBLIC_URL: TEST_ORIGINS.staff,
    ...overrides,
  });
}

/** Configuration accepted for APP_ENV=production (secure cookies). */
export function productionLikeEnv(overrides: Record<string, string> = {}): ApiEnv {
  return integrationEnv({
    NODE_ENV: 'production',
    APP_ENV: 'production',
    API_CORS_ORIGINS: '',
    AUTH_CUSTOMER_ORIGINS: 'https://client.example.test',
    AUTH_STAFF_ORIGINS: 'https://ops.example.test',
    AUTH_CREW_ORIGINS: 'https://crew.example.test',
    AUTH_MAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    AUTH_EMAIL_FROM: 'no-reply@example.test',
    CLIENT_PUBLIC_URL: 'https://client.example.test',
    OPS_PUBLIC_URL: 'https://ops.example.test',
    ...overrides,
  });
}

export interface CapturedLogs {
  lines: Record<string, unknown>[];
  raw: string[];
}

export function captureLogger(): { logger: Logger; logs: CapturedLogs } {
  const logs: CapturedLogs = { lines: [], raw: [] };
  const logger = createLogger({
    service: 'api-test',
    level: 'debug',
    write: (line) => {
      logs.raw.push(line);
      logs.lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { logger, logs };
}

export interface TestApp {
  app: NestExpressApplication;
  logs: CapturedLogs;
  mail: FakeAuthMailProvider;
}

export async function startTestApp(
  env: ApiEnv,
  extraControllers: Type<unknown>[] = [],
): Promise<TestApp> {
  const { logger, logs } = captureLogger();
  const mail = new FakeAuthMailProvider();
  const app = await createApp({ env, logger, extraControllers, mailProvider: mail });
  await app.init();
  return { app, logs, mail };
}
