import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/database/database.service.js';
import { integrationEnv, startTestApp, type CapturedLogs } from '../support/test-app.js';

const LEAKY_DSN = 'postgresql://leaky_user:leaky-password-value@db.internal.example:5432/prod';

/** Test-only routes that fail on purpose; never registered in the real app. */
@Controller({ path: '__test__', version: VERSION_NEUTRAL })
class FailingController {
  constructor(private readonly database: DatabaseService) {}

  @Get('thrown-error')
  thrownError(): never {
    throw new Error(`connect ECONNREFUSED ${LEAKY_DSN}`);
  }

  @Get('database-error')
  async databaseError(): Promise<unknown> {
    // A real PostgreSQL error raised through the official client.
    return this.database.client.$queryRawUnsafe('SELECT * FROM table_that_does_not_exist');
  }
}

describe('public error redaction', () => {
  let app: NestExpressApplication;
  let logs: CapturedLogs;

  beforeAll(async () => {
    ({ app, logs } = await startTestApp(integrationEnv(), [FailingController]));
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['/__test__/thrown-error', '/__test__/database-error'])(
    '%s returns a generic INTERNAL_ERROR body',
    async (path) => {
      const response = await request(app.getHttpServer()).get(path).expect(500);

      expect(response.body).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: response.headers['x-request-id'],
      });
      for (const leak of [
        'leaky_user',
        'leaky-password-value',
        'db.internal.example',
        'postgresql://',
        'table_that_does_not_exist',
        'stack',
        '    at ',
      ]) {
        expect(response.text).not.toContain(leak);
      }
    },
  );

  it('keeps the cause in server logs, with credentials redacted', () => {
    const errors = logs.lines.filter((line) => line.message === 'request failed');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(logs.raw.join('\n')).not.toContain('leaky-password-value');
    expect(logs.raw.join('\n')).toContain('table_that_does_not_exist');
  });
});
