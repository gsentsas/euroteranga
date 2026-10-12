import type { ApiEnv } from '@euroteranga/config';
import type { Logger } from '@euroteranga/logger';
import { createDatabaseClient, pingDatabase, type PrismaClient } from '@euroteranga/database';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { API_ENV, API_LOGGER } from '../config/config.module.js';

/**
 * Owns the process-wide Prisma client. One instance per application; the
 * client connects lazily and is disconnected when the application closes, so
 * restarts, tests and graceful shutdown do not leak pooled connections.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(API_LOGGER) private readonly logger: Logger,
  ) {
    this.client = createDatabaseClient({ databaseUrl: env.DATABASE_URL });
  }

  ping(timeoutMs?: number): Promise<void> {
    return pingDatabase(this.client, timeoutMs);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
    this.logger.info('database connections released');
  }
}
