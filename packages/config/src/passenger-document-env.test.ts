import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadApiEnv, PASSENGER_DOCUMENT_MAX_BYTES_BOUNDS } from './index.js';

const key = () => randomBytes(32).toString('base64');

function env(overrides: Record<string, string> = {}) {
  return {
    APP_ENV: 'local',
    DATABASE_URL: 'postgresql://user:placeholder@localhost:5432/euroteranga_test',
    AUTH_CSRF_KEY: key(),
    AUTH_HMAC_KEY: key(),
    AUTH_TOTP_ENCRYPTION_KEY: key(),
    AUTH_MAIL_PROVIDER: 'disabled',
    CLIENT_PUBLIC_URL: 'http://localhost:3002',
    OPS_PUBLIC_URL: 'http://localhost:3004',
    ...overrides,
  };
}

function deployed(appEnv: 'staging' | 'production', overrides: Record<string, string> = {}) {
  return env({
    APP_ENV: appEnv,
    NODE_ENV: 'production',
    API_TRUST_PROXY: 'loopback',
    AUTH_MAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    AUTH_EMAIL_FROM: 'no-reply@example.test',
    CLIENT_PUBLIC_URL: 'https://client.example.test',
    OPS_PUBLIC_URL: 'https://ops.example.test',
    AUTH_CUSTOMER_ORIGINS: 'https://client.example.test',
    AUTH_STAFF_ORIGINS: 'https://ops.example.test',
    AUTH_CREW_ORIGINS: 'https://crew.example.test',
    ...overrides,
  });
}

const s3 = {
  OBJECT_STORAGE_PROVIDER: 'S3',
  OBJECT_STORAGE_ENDPOINT: 'https://objects.example.test',
  OBJECT_STORAGE_REGION: 'eu-test-1',
  OBJECT_STORAGE_BUCKET: 'euroteranga-private-documents',
  OBJECT_STORAGE_ACCESS_KEY: 'ephemeral-test-access',
  OBJECT_STORAGE_SECRET_KEY: 'ephemeral-test-secret',
  MALWARE_SCANNER: 'CLAMAV',
  CLAMAV_HOST: 'clamav.internal',
};

describe('passenger-document configuration', () => {
  it('is disabled and fail-safe by default', () => {
    expect(loadApiEnv(env())).toMatchObject({
      PASSENGER_DOCUMENT_MAX_BYTES: PASSENGER_DOCUMENT_MAX_BYTES_BOUNDS.default,
      OBJECT_STORAGE_PROVIDER: 'DISABLED',
      MALWARE_SCANNER: 'DISABLED',
    });
  });

  it.each(['local', 'ci'] as const)('accepts the private LOCAL/TEST adapters in %s', (appEnv) => {
    expect(
      loadApiEnv(
        env({
          APP_ENV: appEnv,
          OBJECT_STORAGE_PROVIDER: 'LOCAL',
          OBJECT_STORAGE_LOCAL_ROOT: '/tmp/euroteranga-private-documents',
          MALWARE_SCANNER: 'TEST',
        }),
      ),
    ).toMatchObject({ OBJECT_STORAGE_PROVIDER: 'LOCAL', MALWARE_SCANNER: 'TEST' });
  });

  it.each([
    ['relative root', 'documents', /OBJECT_STORAGE_LOCAL_ROOT: must be an absolute path/],
    ['filesystem root', '/', /OBJECT_STORAGE_LOCAL_ROOT: must be a dedicated directory/],
    ['web root', '/srv/httpdocs/private', /OBJECT_STORAGE_LOCAL_ROOT: must not be a public/],
    ['public root', '/srv/app/public/documents', /OBJECT_STORAGE_LOCAL_ROOT: must not be a public/],
    ['upload root', '/srv/uploads/documents', /OBJECT_STORAGE_LOCAL_ROOT: must not be a public/],
    [
      'cPanel web root',
      '/home/site/public_html/d',
      /OBJECT_STORAGE_LOCAL_ROOT: must not be a public/,
    ],
    ['Apache web root', '/opt/lampp/htdocs/d', /OBJECT_STORAGE_LOCAL_ROOT: must not be a public/],
    ['root via dot-dot', '/tmp/..', /OBJECT_STORAGE_LOCAL_ROOT: must be a normalized path/],
    ['root via double slash', '//', /OBJECT_STORAGE_LOCAL_ROOT: must be a normalized path/],
    ['dot segment', '/tmp/./documents', /OBJECT_STORAGE_LOCAL_ROOT: must be a normalized path/],
  ])('refuses a LOCAL %s', (_label, root, message) => {
    expect(() =>
      loadApiEnv(
        env({
          OBJECT_STORAGE_PROVIDER: 'LOCAL',
          OBJECT_STORAGE_LOCAL_ROOT: root,
          MALWARE_SCANNER: 'TEST',
        }),
      ),
    ).toThrow(message);
  });

  it('never enables storage without a scanner', () => {
    expect(() =>
      loadApiEnv(
        env({
          OBJECT_STORAGE_PROVIDER: 'LOCAL',
          OBJECT_STORAGE_LOCAL_ROOT: '/tmp/euroteranga-private-documents',
        }),
      ),
    ).toThrow(/MALWARE_SCANNER: must fail closed/);
    expect(() => loadApiEnv(env({ MALWARE_SCANNER: 'TEST' }))).toThrow(
      /MALWARE_SCANNER: must be DISABLED/,
    );
  });

  it.each(['staging', 'production'] as const)(
    'refuses LOCAL storage and the TEST scanner in %s',
    (appEnv) => {
      expect(() =>
        loadApiEnv(
          deployed(appEnv, {
            OBJECT_STORAGE_PROVIDER: 'LOCAL',
            OBJECT_STORAGE_LOCAL_ROOT: '/tmp/euroteranga-private-documents',
            MALWARE_SCANNER: 'TEST',
          }),
        ),
      ).toThrow(/OBJECT_STORAGE_PROVIDER: LOCAL is refused|MALWARE_SCANNER: TEST is refused/);
    },
  );

  it.each(['staging', 'production'] as const)(
    'refuses LOCAL storage on its own in %s, even with a real scanner',
    (appEnv) => {
      expect(() =>
        loadApiEnv(
          deployed(appEnv, {
            OBJECT_STORAGE_PROVIDER: 'LOCAL',
            OBJECT_STORAGE_LOCAL_ROOT: '/srv/euroteranga-private-documents',
            MALWARE_SCANNER: 'CLAMAV',
            CLAMAV_HOST: 'clamav.internal',
          }),
        ),
      ).toThrow(/OBJECT_STORAGE_PROVIDER: LOCAL is refused in staging and production/);
    },
  );

  it.each(['staging', 'production'] as const)(
    'refuses the TEST scanner on its own in %s, even with private S3',
    (appEnv) => {
      expect(() => loadApiEnv(deployed(appEnv, { ...s3, MALWARE_SCANNER: 'TEST' }))).toThrow(
        /MALWARE_SCANNER: TEST is refused in staging and production/,
      );
    },
  );

  it('requires a complete S3 and ClamAV configuration', () => {
    expect(loadApiEnv(deployed('production', s3))).toMatchObject({
      OBJECT_STORAGE_PROVIDER: 'S3',
      MALWARE_SCANNER: 'CLAMAV',
      CLAMAV_PORT: 3310,
      CLAMAV_TIMEOUT_MS: 10_000,
    });
    for (const name of [
      'OBJECT_STORAGE_ENDPOINT',
      'OBJECT_STORAGE_REGION',
      'OBJECT_STORAGE_BUCKET',
      'OBJECT_STORAGE_ACCESS_KEY',
      'OBJECT_STORAGE_SECRET_KEY',
      'CLAMAV_HOST',
    ] as const) {
      expect(() => loadApiEnv(deployed('production', { ...s3, [name]: '' }))).toThrow(
        new RegExp(name),
      );
    }
  });

  it('requires TLS for the deployed object endpoint', () => {
    expect(() =>
      loadApiEnv(
        deployed('production', { ...s3, OBJECT_STORAGE_ENDPOINT: 'http://objects.internal' }),
      ),
    ).toThrow(/OBJECT_STORAGE_ENDPOINT: must use https/);
    expect(() =>
      loadApiEnv(env({ ...s3, OBJECT_STORAGE_ENDPOINT: 'ftp://objects.internal' })),
    ).toThrow(/OBJECT_STORAGE_ENDPOINT: must use the http or https protocol/);
  });

  it.each([
    String(PASSENGER_DOCUMENT_MAX_BYTES_BOUNDS.min - 1),
    String(PASSENGER_DOCUMENT_MAX_BYTES_BOUNDS.max + 1),
    '1.5',
  ])('bounds PASSENGER_DOCUMENT_MAX_BYTES=%s', (value) => {
    expect(() => loadApiEnv(env({ PASSENGER_DOCUMENT_MAX_BYTES: value }))).toThrow(
      /PASSENGER_DOCUMENT_MAX_BYTES/,
    );
  });
});
