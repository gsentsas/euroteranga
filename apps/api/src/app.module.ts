import type { ApiEnv } from '@euroteranga/config';
import type { Logger } from '@euroteranga/logger';
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import type { AuthMailProvider } from './auth/mail/auth-mail.provider.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';

export interface AppModuleOptions {
  env: ApiEnv;
  logger: Logger;
  extraControllers?: Type<unknown>[];
  mailProvider?: AuthMailProvider;
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(options.env, options.logger),
        DatabaseModule,
        HealthModule,
        AuthModule.register(options.mailProvider ? { mailProvider: options.mailProvider } : {}),
      ],
      controllers: options.extraControllers ?? [],
    };
  }
}
