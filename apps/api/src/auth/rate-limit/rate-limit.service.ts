import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { AUTH_CONFIG, type AuthConfig } from '../auth.config.js';
import { keyedDigest } from '../crypto/tokens.js';
import { AuthErrors } from '../http/public-api-error.js';
import { SecurityEventLogger } from '../security-log/security-events.js';
import type { RateLimitRule } from './rate-limit.rules.js';

interface Window {
  key: Buffer;
  start: Date;
  end: Date;
}

/**
 * Fixed-window counters stored in PostgreSQL, so limits hold across several
 * API processes without Redis. Bucket keys are HMACs of the action and the
 * limited signal: neither emails nor IP addresses are stored.
 */
@Injectable()
export class RateLimitService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly securityLog: SecurityEventLogger,
  ) {}

  /** Counts one attempt and throws 429 once the limit is exceeded. */
  async consume(rule: RateLimitRule, subject: string): Promise<void> {
    const count = await this.increment(rule, subject);
    if (count > rule.limit) this.reject(rule, subject);
  }

  /** Throws 429 if the limit is already reached, without counting. */
  async assertNotExceeded(rule: RateLimitRule, subject: string): Promise<void> {
    const window = this.window(rule, subject);
    const rows = await this.database.client.$queryRaw<{ count: number }[]>`
      SELECT "count" FROM "auth_rate_limit_bucket"
      WHERE "key" = ${window.key} AND "window_start" = ${window.start}`;
    if ((rows[0]?.count ?? 0) >= rule.limit) this.reject(rule, subject);
  }

  /** Counts one attempt (e.g. a failure) and returns the window total. */
  async increment(rule: RateLimitRule, subject: string): Promise<number> {
    const window = this.window(rule, subject);
    const rows = await this.database.client.$queryRaw<{ count: number }[]>`
      INSERT INTO "auth_rate_limit_bucket" ("key", "window_start", "action", "count", "expires_at")
      VALUES (${window.key}, ${window.start}, ${rule.action}, 1, ${window.end})
      ON CONFLICT ("key", "window_start")
      DO UPDATE SET "count" = "auth_rate_limit_bucket"."count" + 1
      RETURNING "count"`;
    return rows[0]?.count ?? 1;
  }

  private window(rule: RateLimitRule, subject: string): Window {
    const now = Date.now();
    const startMs = Math.floor(now / rule.windowMs) * rule.windowMs;
    return {
      key: keyedDigest(this.config.hmacKey, ['rate-limit', rule.action, subject]),
      start: new Date(startMs),
      end: new Date(startMs + rule.windowMs),
    };
  }

  private reject(rule: RateLimitRule, subject: string): never {
    const window = this.window(rule, subject);
    this.securityLog.record('AUTH_RATE_LIMITED', { action: rule.action, subject });
    throw AuthErrors.tooManyRequests((window.end.getTime() - Date.now()) / 1000);
  }
}
