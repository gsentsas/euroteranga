import type { ApiEnv } from '@euroteranga/config';
import type { Logger } from '@euroteranga/logger';
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { BookingModule } from './bookings/booking.module.js';
import { ComplianceModule } from './compliance/compliance.module.js';
import type { AuthMailProvider } from './auth/mail/auth-mail.provider.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { FleetModule } from './fleet/fleet.module.js';
import { HealthModule } from './health/health.module.js';
import { NetworkModule } from './network/network.module.js';
import { PaymentModule } from './payments/payment.module.js';
import { PassengerDocumentModule } from './passenger-documents/passenger-document.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { SeatMapModule } from './seat-maps/seat-map.module.js';
import { TripModule } from './trips/trip.module.js';

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
        // AuthorizationModule registers AuthModule (single instance).
        AuthorizationModule.register(
          options.mailProvider ? { mailProvider: options.mailProvider } : {},
        ),
        NetworkModule,
        FleetModule,
        TripModule,
        SeatMapModule,
        PricingModule,
        BookingModule,
        PaymentModule,
        PassengerDocumentModule,
        ComplianceModule,
      ],
      controllers: options.extraControllers ?? [],
    };
  }
}
