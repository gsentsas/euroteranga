import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createOpenApiDocument } from '../../src/openapi.js';
import { integrationEnv, startTestApp } from '../support/test-app.js';

describe('OpenAPI', () => {
  it('generates a valid document describing the health endpoints', async () => {
    const { app } = await startTestApp(integrationEnv());
    try {
      const document = createOpenApiDocument(app);

      expect(document.openapi).toMatch(/^3\./);
      expect(document.info.title).toBe('EURO TERANGA API');
      expect(Object.keys(document.paths).sort()).toEqual([
        '/health',
        '/health/live',
        '/health/ready',
      ]);
    } finally {
      await app.close();
    }
  });

  it('does not expose the documentation unless OPENAPI_ENABLED=true', async () => {
    const disabled = await startTestApp(integrationEnv({ OPENAPI_ENABLED: 'false' }));
    try {
      await request(disabled.app.getHttpServer()).get('/docs-json').expect(404);
    } finally {
      await disabled.app.close();
    }

    const enabled = await startTestApp(integrationEnv({ OPENAPI_ENABLED: 'true' }));
    try {
      const response = await request(enabled.app.getHttpServer()).get('/docs-json').expect(200);
      expect(response.body.paths).toHaveProperty('/health/ready');
    } finally {
      await enabled.app.close();
    }
  });
});
