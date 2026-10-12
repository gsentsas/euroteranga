import 'reflect-metadata';
import { loadApiEnv, type ApiEnv } from '@euroteranga/config';
import { createLogger, type Logger } from '@euroteranga/logger';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../../src/app.factory.js';

/**
 * Integration tests need a real, disposable PostgreSQL database. They fail
 * loudly rather than silently skipping when none is configured.
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
    LOG_LEVEL: 'debug',
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

export async function startTestApp(
  env: ApiEnv,
  extraControllers: Type<unknown>[] = [],
): Promise<{ app: NestExpressApplication; logs: CapturedLogs }> {
  const { logger, logs } = captureLogger();
  const app = await createApp({ env, logger, extraControllers });
  await app.init();
  return { app, logs };
}
