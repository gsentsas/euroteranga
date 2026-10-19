import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  loadApiEnv,
  PUBLIC_MEDIA_MAX_BYTES_BOUNDS,
  PUBLIC_MEDIA_MAX_PIXELS_BOUNDS,
} from './index.js';

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

function production(overrides: Record<string, string> = {}) {
  return env({
    APP_ENV: 'production',
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

function problems(input: Record<string, string>): string {
  try {
    loadApiEnv(input);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('public media library configuration (MEDIA-1)', () => {
  it('is disabled by default with bounded limits', () => {
    const parsed = loadApiEnv(env());
    expect(parsed.PUBLIC_MEDIA_STORAGE).toBe('DISABLED');
    expect(parsed.PUBLIC_MEDIA_MAX_BYTES).toBe(PUBLIC_MEDIA_MAX_BYTES_BOUNDS.default);
    expect(parsed.PUBLIC_MEDIA_MAX_PIXELS).toBe(PUBLIC_MEDIA_MAX_PIXELS_BOUNDS.default);
    expect(problems(env({ PUBLIC_MEDIA_MAX_BYTES: String(30 * 1024 * 1024) }))).toContain(
      'PUBLIC_MEDIA_MAX_BYTES',
    );
    expect(problems(env({ PUBLIC_MEDIA_MAX_PIXELS: '500000000' }))).toContain(
      'PUBLIC_MEDIA_MAX_PIXELS',
    );
  });

  it('needs a dedicated, absolute, non-public root for LOCAL storage', () => {
    expect(problems(env({ PUBLIC_MEDIA_STORAGE: 'LOCAL' }))).toContain(
      'is required when PUBLIC_MEDIA_STORAGE=LOCAL',
    );
    for (const [root, message] of [
      ['relative/media', 'must be an absolute path'],
      ['/srv/media/../..', 'must be a normalized path'],
      ['/', 'must be a dedicated directory'],
      ['/var/www/vhosts/example/httpdocs/media', 'must not be a public or upload directory'],
    ] as const) {
      expect(
        problems(env({ PUBLIC_MEDIA_STORAGE: 'LOCAL', PUBLIC_MEDIA_LOCAL_ROOT: root })),
      ).toContain(message);
    }
    expect(
      loadApiEnv(env({ PUBLIC_MEDIA_STORAGE: 'LOCAL', PUBLIC_MEDIA_LOCAL_ROOT: '/srv/et/media' }))
        .PUBLIC_MEDIA_LOCAL_ROOT,
    ).toBe('/srv/et/media');
  });

  it('never shares a directory with the private passenger documents', () => {
    const documents = {
      OBJECT_STORAGE_PROVIDER: 'LOCAL',
      OBJECT_STORAGE_LOCAL_ROOT: '/srv/et/private',
      MALWARE_SCANNER: 'TEST',
      PUBLIC_MEDIA_STORAGE: 'LOCAL',
    };
    for (const root of [
      '/srv/et/private',
      '/srv/et/private/media',
      '/srv/et',
      '/srv/et/private/',
    ]) {
      expect(problems(env({ ...documents, PUBLIC_MEDIA_LOCAL_ROOT: root }))).toContain(
        'must be separate from OBJECT_STORAGE_LOCAL_ROOT',
      );
    }
    expect(problems(env({ ...documents, PUBLIC_MEDIA_LOCAL_ROOT: '/srv/et/private-media' }))).toBe(
      '',
    );
  });

  it('allows LOCAL public media in production, unlike passenger documents', () => {
    expect(
      loadApiEnv(
        production({ PUBLIC_MEDIA_STORAGE: 'LOCAL', PUBLIC_MEDIA_LOCAL_ROOT: '/srv/et/media' }),
      ).PUBLIC_MEDIA_STORAGE,
    ).toBe('LOCAL');
    expect(
      problems(
        production({
          OBJECT_STORAGE_PROVIDER: 'LOCAL',
          OBJECT_STORAGE_LOCAL_ROOT: '/srv/et/private',
          MALWARE_SCANNER: 'CLAMAV',
          CLAMAV_HOST: 'clamav.internal',
        }),
      ),
    ).toContain('LOCAL is refused in staging and production');
  });
});
