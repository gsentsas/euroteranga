import type { ApiEnv } from '@euroteranga/config';
import type { Logger } from '@euroteranga/logger';
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';

export interface AppModuleOptions {
  env: ApiEnv;
  logger: Logger;
  extraControllers?: Type<unknown>[];
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(options.env, options.logger), DatabaseModule, HealthModule],
      controllers: options.extraControllers ?? [],
    };
  }
}
