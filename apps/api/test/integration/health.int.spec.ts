import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrationEnv, startTestApp } from '../support/test-app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('health endpoints (real PostgreSQL)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await startTestApp(integrationEnv()));
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns only {"status":"ok"} with baseline headers', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['x-request-id']).toMatch(UUID);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('GET /health/live returns {"status":"ok"}', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready returns {"status":"ok"} when PostgreSQL answers', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('propagates a valid incoming request id and replaces an invalid one', async () => {
    const kept = await request(app.getHttpServer())
      .get('/health')
      .set('X-Request-Id', 'proxy-request-0001');
    expect(kept.headers['x-request-id']).toBe('proxy-request-0001');

    const replaced = await request(app.getHttpServer())
      .get('/health')
      .set('X-Request-Id', 'bad id');
    expect(replaced.headers['x-request-id']).toMatch(UUID);
  });

  it('returns the foundation error shape for unknown routes', async () => {
    const response = await request(app.getHttpServer()).get('/does-not-exist').expect(404);

    expect(response.body).toEqual({
      code: 'NOT_FOUND',
      message: 'Resource not found',
      requestId: response.headers['x-request-id'],
    });
  });

  it('only allows configured CORS origins and never uses a wildcard', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();

    const denied = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
