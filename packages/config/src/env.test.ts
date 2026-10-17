import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  assertNoSensitivePublicEnv,
  createFoundationNextConfig,
  loadApiEnv,
  loadPublicEnv,
} from './index.js';

// Keys are generated per run: no static secret-looking value in the repository.
const key = () => randomBytes(32).toString('base64');

const validApiEnv = {
  APP_ENV: 'local',
  DATABASE_URL: 'postgresql://user:placeholder@localhost:5432/euroteranga_test',
  AUTH_CSRF_KEY: key(),
  AUTH_HMAC_KEY: key(),
  AUTH_TOTP_ENCRYPTION_KEY: key(),
  AUTH_MAIL_PROVIDER: 'disabled',
  CLIENT_PUBLIC_URL: 'http://localhost:3002',
  OPS_PUBLIC_URL: 'http://localhost:3004',
};

describe('loadApiEnv', () => {
  it('applies defaults for optional variables', () => {
    const env = loadApiEnv(validApiEnv);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      APP_ENV: 'local',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      API_CORS_ORIGINS: [],
      API_TRUST_PROXY: 'none',
      OPENAPI_ENABLED: false,
      LOG_LEVEL: 'info',
      BOOKING_HOLD_TTL_SECONDS: 900,
      BOOKING_MAX_SEATS_PER_HOLD: 8,
    });
  });

  it('accepts booking hold settings within their documented bounds', () => {
    for (const [ttl, seats] of [
      ['60', '1'],
      ['3600', '20'],
      ['600', '4'],
    ] as const) {
      expect(
        loadApiEnv({
          ...validApiEnv,
          BOOKING_HOLD_TTL_SECONDS: ttl,
          BOOKING_MAX_SEATS_PER_HOLD: seats,
        }),
      ).toMatchObject({
        BOOKING_HOLD_TTL_SECONDS: Number(ttl),
        BOOKING_MAX_SEATS_PER_HOLD: Number(seats),
      });
    }
  });

  it.each([
    ['BOOKING_HOLD_TTL_SECONDS', '59'],
    ['BOOKING_HOLD_TTL_SECONDS', '3601'],
    ['BOOKING_HOLD_TTL_SECONDS', '90.5'],
    ['BOOKING_HOLD_TTL_SECONDS', 'soon'],
    ['BOOKING_MAX_SEATS_PER_HOLD', '0'],
    ['BOOKING_MAX_SEATS_PER_HOLD', '21'],
    ['BOOKING_MAX_SEATS_PER_HOLD', '2.5'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadApiEnv({ ...validApiEnv, [name]: value })).toThrow(new RegExp(name));
  });

  it('fails fast and names every missing required variable', () => {
    expect(() => loadApiEnv({})).toThrow(ConfigValidationError);
    try {
      loadApiEnv({});
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('APP_ENV');
      expect(message).toContain('AUTH_CSRF_KEY');
      expect(message).toContain('AUTH_TOTP_ENCRYPTION_KEY');
    }
  });

  it('never echoes the received value of an invalid variable', () => {
    const leakedPassword = 'super-sensitive-password';
    let message = '';
    try {
      loadApiEnv({ ...validApiEnv, DATABASE_URL: `mysql://admin:${leakedPassword}@db.internal/x` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(leakedPassword);
    expect(message).not.toContain('db.internal');
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadApiEnv({ ...validApiEnv, API_PORT: '70000' })).toThrow(/API_PORT/);
  });

  it('parses a comma-separated origin allow-list', () => {
    const env = loadApiEnv({
      ...validApiEnv,
      API_CORS_ORIGINS: 'http://localhost:3000, http://localhost:3001',
    });
    expect(env.API_CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3001']);
  });

  it.each(['*', 'http://localhost:3000/path', 'ftp://example.test', 'not-a-url'])(
    'rejects the CORS origin %s',
    (origin) => {
      expect(() => loadApiEnv({ ...validApiEnv, API_CORS_ORIGINS: origin })).toThrow(
        /API_CORS_ORIGINS/,
      );
    },
  );

  it('parses boolean flags strictly', () => {
    expect(loadApiEnv({ ...validApiEnv, OPENAPI_ENABLED: 'true' }).OPENAPI_ENABLED).toBe(true);
    expect(() => loadApiEnv({ ...validApiEnv, OPENAPI_ENABLED: 'yes' })).toThrow(/OPENAPI_ENABLED/);
  });

  it('requires the audited loopback proxy topology in staging and production', () => {
    const deployed = {
      ...validApiEnv,
      NODE_ENV: 'production',
      APP_ENV: 'production',
      API_TRUST_PROXY: 'none',
      AUTH_MAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.test',
      AUTH_EMAIL_FROM: 'no-reply@example.test',
      CLIENT_PUBLIC_URL: 'https://client.example.test',
      OPS_PUBLIC_URL: 'https://ops.example.test',
      AUTH_CUSTOMER_ORIGINS: 'https://client.example.test',
      AUTH_STAFF_ORIGINS: 'https://ops.example.test',
      AUTH_CREW_ORIGINS: 'https://crew.example.test',
      PAYMENT_PROVIDER: 'DISABLED',
      OBJECT_STORAGE_PROVIDER: 'DISABLED',
      MALWARE_SCANNER: 'DISABLED',
    };
    expect(() => loadApiEnv(deployed)).toThrow(/API_TRUST_PROXY/);
    expect(loadApiEnv({ ...deployed, API_TRUST_PROXY: 'loopback' }).API_TRUST_PROXY).toBe(
      'loopback',
    );
  });
});

describe('loadPublicEnv', () => {
  it('accepts a valid public configuration', () => {
    expect(
      loadPublicEnv({
        NEXT_PUBLIC_APP_ENV: 'ci',
        NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4000',
      }),
    ).toEqual({ NEXT_PUBLIC_APP_ENV: 'ci', NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4000' });
  });

  it('rejects a missing or non-http API base URL', () => {
    expect(() => loadPublicEnv({ NEXT_PUBLIC_APP_ENV: 'ci' })).toThrow(/NEXT_PUBLIC_API_BASE_URL/);
    expect(
      loadPublicEnv({
        NEXT_PUBLIC_APP_ENV: 'ci',
        NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4000',
        NEXT_PUBLIC_CLIENT_URL: 'http://localhost:3002',
      }).NEXT_PUBLIC_CLIENT_URL,
    ).toBe('http://localhost:3002');
    expect(() =>
      loadPublicEnv({
        NEXT_PUBLIC_APP_ENV: 'ci',
        NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4000',
        NEXT_PUBLIC_CLIENT_URL: 'javascript:alert(1)',
      }),
    ).toThrow(/NEXT_PUBLIC_CLIENT_URL/);
    expect(() =>
      loadPublicEnv({ NEXT_PUBLIC_APP_ENV: 'ci', NEXT_PUBLIC_API_BASE_URL: 'javascript:alert(1)' }),
    ).toThrow(/NEXT_PUBLIC_API_BASE_URL/);
  });

  it('requires https browser endpoints in staging and production', () => {
    expect(() =>
      loadPublicEnv({
        NEXT_PUBLIC_APP_ENV: 'production',
        NEXT_PUBLIC_API_BASE_URL: 'http://api.example.test',
      }),
    ).toThrow(/NEXT_PUBLIC_API_BASE_URL/);
    expect(() =>
      loadPublicEnv({
        NEXT_PUBLIC_APP_ENV: 'staging',
        NEXT_PUBLIC_API_BASE_URL: 'https://api.example.test',
        NEXT_PUBLIC_CLIENT_URL: 'http://client.example.test',
      }),
    ).toThrow(/NEXT_PUBLIC_CLIENT_URL/);
    expect(
      loadPublicEnv({
        NEXT_PUBLIC_APP_ENV: 'production',
        NEXT_PUBLIC_API_BASE_URL: 'https://api.example.test',
        NEXT_PUBLIC_CLIENT_URL: 'https://client.example.test',
      }),
    ).toMatchObject({ NEXT_PUBLIC_APP_ENV: 'production' });
  });
});

describe('assertNoSensitivePublicEnv', () => {
  it('allows ordinary public variables', () => {
    expect(() =>
      assertNoSensitivePublicEnv({ NEXT_PUBLIC_APP_ENV: 'ci', DATABASE_URL: 'server-only' }),
    ).not.toThrow();
  });

  it.each(['NEXT_PUBLIC_API_KEY', 'NEXT_PUBLIC_SESSION_SECRET', 'NEXT_PUBLIC_DATABASE_URL'])(
    'rejects %s',
    (name) => {
      expect(() => assertNoSensitivePublicEnv({ [name]: 'x' })).toThrow(name);
    },
  );
});

describe('createFoundationNextConfig', () => {
  const publicEnv = {
    NEXT_PUBLIC_APP_ENV: 'ci',
    NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4000',
  };

  it('returns hardened defaults and the baseline security headers', async () => {
    const config = createFoundationNextConfig(publicEnv);
    expect(config.poweredByHeader).toBe(false);
    expect(config.reactStrictMode).toBe(true);

    const [rule] = await config.headers();
    expect(rule?.source).toBe('/:path*');
    expect(rule?.headers).toContainEqual({ key: 'X-Content-Type-Options', value: 'nosniff' });
    const csp = rule?.headers.find((header) => header.key === 'Content-Security-Policy')?.value;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' http://localhost:4000");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('adds deployment-only CSP upgrading and keeps the API origin explicit', async () => {
    const config = createFoundationNextConfig({
      NEXT_PUBLIC_APP_ENV: 'production',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.test',
    });
    const [rule] = await config.headers();
    const csp = rule?.headers.find((header) => header.key === 'Content-Security-Policy')?.value;
    expect(csp).toContain("connect-src 'self' https://api.example.test");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('stops the build when the public environment is invalid or sensitive', () => {
    expect(() => createFoundationNextConfig({ NEXT_PUBLIC_APP_ENV: 'ci' })).toThrow(
      /NEXT_PUBLIC_API_BASE_URL/,
    );
    expect(() =>
      createFoundationNextConfig({ ...publicEnv, NEXT_PUBLIC_STRIPE_SECRET: 'x' }),
    ).toThrow(/NEXT_PUBLIC_STRIPE_SECRET/);
  });
});
