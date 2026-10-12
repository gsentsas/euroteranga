import type { ApiEnv } from '@euroteranga/config';
import type { Logger } from '@euroteranga/logger';
import { Module, type DynamicModule } from '@nestjs/common';

/** Validated environment, loaded once at startup by main.ts. */
export const API_ENV = Symbol('API_ENV');
/** Structured JSON logger shared by the whole API. */
export const API_LOGGER = Symbol('API_LOGGER');

@Module({})
export class ConfigModule {
  static forRoot(env: ApiEnv, logger: Logger): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: API_LOGGER, useValue: logger },
      ],
      exports: [API_ENV, API_LOGGER],
    };
  }
}
