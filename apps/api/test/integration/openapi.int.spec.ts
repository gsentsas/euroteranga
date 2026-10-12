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
      const paths = Object.keys(document.paths);
      expect(paths).toEqual(expect.arrayContaining(['/health', '/health/live', '/health/ready']));
      expect(paths).toEqual(
        expect.arrayContaining([
          '/v1/auth/customer/register',
          '/v1/auth/customer/verify-email',
          '/v1/auth/customer/password/forgot',
          '/v1/auth/customer/password/reset',
          '/v1/auth/{realm}/login',
          '/v1/auth/{realm}/me',
          '/v1/auth/{realm}/csrf',
          '/v1/auth/{realm}/logout',
          '/v1/auth/staff/mfa/verify',
        ]),
      );
      // No public self-registration for staff or crew.
      expect(paths.some((path) => /\/(staff|crew)\/register/.test(path))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('marks passwords, tokens and codes as write-only in request schemas', async () => {
    const { app } = await startTestApp(integrationEnv());
    try {
      const schemas = createOpenApiDocument(app).components?.schemas ?? {};
      const property = (schema: string, name: string) =>
        (schemas[schema] as { properties: Record<string, { writeOnly?: boolean }> }).properties[
          name
        ];
      expect(property('LoginBody', 'password')?.writeOnly).toBe(true);
      expect(property('RegisterBody', 'password')?.writeOnly).toBe(true);
      expect(property('ResetPasswordBody', 'token')?.writeOnly).toBe(true);
      expect(property('MfaVerifyBody', 'recoveryCode')?.writeOnly).toBe(true);
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
