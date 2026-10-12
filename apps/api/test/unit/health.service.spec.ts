import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../src/database/database.service.js';
import { HealthService, READINESS_TIMEOUT_MS } from '../../src/health/health.service.js';
import { captureLogger } from '../support/test-app.js';

function fakeDatabase(ping: (timeoutMs?: number) => Promise<void>): DatabaseService {
  return { ping } as unknown as DatabaseService;
}

describe('HealthService.isReady', () => {
  it('is ready when the database answers, and bounds the probe duration', async () => {
    const received: (number | undefined)[] = [];
    const { logger } = captureLogger();
    const service = new HealthService(
      fakeDatabase(async (timeoutMs) => {
        received.push(timeoutMs);
      }),
      logger,
    );

    await expect(service.isReady()).resolves.toBe(true);
    expect(received).toEqual([READINESS_TIMEOUT_MS]);
  });

  it('is not ready when the database fails, and logs the cause redacted', async () => {
    const { logger, logs } = captureLogger();
    const service = new HealthService(
      fakeDatabase(async () => {
        throw new Error('connect ECONNREFUSED postgresql://app:s3cret@db.internal:5432/prod');
      }),
      logger,
    );

    await expect(service.isReady()).resolves.toBe(false);
    expect(logs.lines[0]).toMatchObject({ level: 'warn', message: 'readiness check failed' });
    expect(logs.raw.join('\n')).not.toContain('s3cret');
  });
});
