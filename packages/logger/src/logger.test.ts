import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, redact, redactString } from './index.js';

function captureLogger(level: 'debug' | 'info' = 'info', requestId?: string) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'test-service',
    level,
    context: () => ({ requestId }),
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes one JSON document with the mandatory fields', () => {
    const { logger, lines } = captureLogger('info', 'req-12345678');
    logger.info('request completed', { status: 200 });

    expect(lines).toHaveLength(1);
    const [entry] = lines;
    expect(entry).toMatchObject({
      level: 'info',
      service: 'test-service',
      message: 'request completed',
      request_id: 'req-12345678',
      status: 200,
    });
    expect(Date.parse(String(entry?.timestamp))).not.toBeNaN();
  });

  it('drops entries below the configured level', () => {
    const { logger, lines } = captureLogger('info');
    logger.debug('noisy');
    logger.warn('kept');
    expect(lines.map((line) => line.message)).toEqual(['kept']);
  });

  it('does not let caller fields overwrite reserved fields', () => {
    const { logger, lines } = captureLogger('info', 'real-request-id');
    logger.info('message', { level: 'debug', service: 'spoofed', request_id: 'forged' });
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'test-service',
      request_id: 'real-request-id',
    });
  });

  it('redacts sensitive headers and credentials before writing', () => {
    const { logger, lines } = captureLogger();
    logger.error('database unreachable at postgresql://app:hunter2@db.internal:5432/prod', {
      headers: { Authorization: 'Bearer abc.def.ghi', Cookie: 'sid=123', accept: 'text/html' },
      error: new Error('connect failed for postgres://app:hunter2@db.internal/prod'),
    });

    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('abc.def.ghi');
    expect(serialized).not.toContain('sid=123');
    expect(lines[0]).toMatchObject({
      headers: { Authorization: REDACTED, Cookie: REDACTED, accept: 'text/html' },
    });
  });

  it('carries bindings into child loggers', () => {
    const { logger, lines } = captureLogger();
    logger.child({ component: 'health' }).info('ready');
    expect(lines[0]).toMatchObject({ component: 'health', message: 'ready' });
  });
});

describe('redact', () => {
  it('masks sensitive keys regardless of case and separators', () => {
    expect(
      redact({
        'Set-Cookie': 'a',
        set_cookie: 'b',
        DATABASE_URL: 'postgresql://x:y@z/db',
        apiKey: 'k',
        nested: { refresh_token: 't', ok: 'visible' },
      }),
    ).toEqual({
      'Set-Cookie': REDACTED,
      set_cookie: REDACTED,
      DATABASE_URL: REDACTED,
      apiKey: REDACTED,
      nested: { refresh_token: REDACTED, ok: 'visible' },
    });
  });

  it('serialises errors without stack unless requested', () => {
    const error = new Error('boom');
    expect(redact(error)).toEqual({ name: 'Error', message: 'boom' });
    expect(redact(error, { includeStack: true })).toHaveProperty('stack');
  });

  it('survives circular structures', () => {
    const value: Record<string, unknown> = { name: 'loop' };
    value.self = value;
    expect(redact(value)).toEqual({ name: 'loop', self: '[Circular]' });
  });
});

describe('authentication material', () => {
  it('masks TOTP, recovery codes, CSRF and challenge tokens by key', () => {
    expect(
      redact({
        totpCode: '123456',
        otp: '654321',
        recoveryCodes: ['AAAA-BBBB'],
        csrfToken: 'v1.x.y.z',
        challengeToken: 'abc',
        sessionToken: 'def',
        realm: 'STAFF',
      }),
    ).toEqual({
      totpCode: REDACTED,
      otp: REDACTED,
      recoveryCodes: REDACTED,
      csrfToken: REDACTED,
      challengeToken: REDACTED,
      sessionToken: REDACTED,
      realm: 'STAFF',
    });
  });

  it('removes the secret from otpauth URIs found in free text', () => {
    expect(
      redactString('uri otpauth://totp/EURO%20TERANGA:x?secret=JBSWY3DPEHPK3PXP&issuer=EURO'),
    ).toBe(`uri otpauth://totp/EURO%20TERANGA:x?secret=${REDACTED}&issuer=EURO`);
  });
});

describe('redactString', () => {
  it('removes user info from connection strings and bearer tokens', () => {
    expect(redactString('postgresql://user:pass@host:5432/db')).toBe(
      `postgresql://${REDACTED}@host:5432/db`,
    );
    expect(redactString('Authorization: Bearer eyJhbGciOi.payload.sig')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it('redacts Basic credentials too', () => {
    expect(redactString('Authorization: Basic dXNlcjpwYXNz')).toBe(
      `Authorization: Basic ${REDACTED}`,
    );
  });

  it('leaves ordinary URLs untouched', () => {
    expect(redactString('see https://euroteranga.com/faq')).toBe('see https://euroteranga.com/faq');
  });

  it('handles long attacker-controlled text in linear scanners', () => {
    const value = 'a'.repeat(100_000);
    expect(redactString(value)).toBe(value);
  });
});
