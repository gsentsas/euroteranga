import type { Logger } from '@euroteranga/logger';
import { Inject, Injectable } from '@nestjs/common';
import { API_LOGGER } from '../config/config.module.js';
import { DatabaseService } from '../database/database.service.js';

/** Upper bound for the readiness probe, so orchestrators never hang on it. */
export const READINESS_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  // Typed with the concrete class: Nest resolves injection from the emitted
  // design-time type, which a structural type like Pick<> would erase.
  constructor(
    private readonly database: DatabaseService,
    @Inject(API_LOGGER) private readonly logger: Logger,
  ) {}

  /** True only when every dependency required to serve traffic answers. */
  async isReady(): Promise<boolean> {
    try {
      await this.database.ping(READINESS_TIMEOUT_MS);
      return true;
    } catch (error) {
      // The cause stays in server logs (redacted); clients only see "error".
      this.logger.warn('readiness check failed', { dependency: 'database', error });
      return false;
    }
  }
}
