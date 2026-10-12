import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrationEnv, startTestApp, type CapturedLogs } from '../support/test-app.js';

// Nothing listens on port 1: the connection is refused immediately, which is a
// real database outage from the API's point of view (no mock involved).
const UNREACHABLE_DATABASE_URL =
  'postgresql://ghost_user:ghost-password-value@127.0.0.1:1/ghost_database';

describe('readiness with PostgreSQL unreachable', () => {
  let app: NestExpressApplication;
  let logs: CapturedLogs;

  beforeAll(async () => {
    ({ app, logs } = await startTestApp(
      integrationEnv({ DATABASE_URL: UNREACHABLE_DATABASE_URL }),
    ));
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/ready returns 503 {"status":"error"} without leaking details', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(response.body).toEqual({ status: 'error' });
    for (const secret of ['ghost_user', 'ghost-password-value', '127.0.0.1', 'ghost_database']) {
      expect(response.text).not.toContain(secret);
    }
  });

  it('keeps liveness independent from the database', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
  });

  it('logs the failure server-side with credentials redacted', () => {
    const failure = logs.lines.find((line) => line.message === 'readiness check failed');
    expect(failure).toBeDefined();
    expect(logs.raw.join('\n')).not.toContain('ghost-password-value');
  });
});
