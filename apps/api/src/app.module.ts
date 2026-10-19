import type { ApiEnv } from '@euroteranga/config';
import type { Logger } from '@euroteranga/logger';
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { BaggageModule } from './baggage/baggage.module.js';
import { BorderModule } from './borders/border.module.js';
import { CheckInModule } from './check-in/check-in.module.js';
import { BookingModule } from './bookings/booking.module.js';
import { ComplianceModule } from './compliance/compliance.module.js';
import type { AuthMailProvider } from './auth/mail/auth-mail.provider.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { CrewModule } from './crew/crew.module.js';
import { DepartureReadinessModule } from './departure-readiness/departure-readiness.module.js';
import { FleetModule } from './fleet/fleet.module.js';
import { HealthModule } from './health/health.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { IncidentModule } from './incidents/incident.module.js';
import { ManifestModule } from './manifests/manifest.module.js';
import { NetworkModule } from './network/network.module.js';
import { PaymentModule } from './payments/payment.module.js';
import { PassengerDocumentModule } from './passenger-documents/passenger-document.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { ReportingModule } from './reporting/reporting.module.js';
import { ContentModule } from './content/content.module.js';
import { MediaModule } from './media/media.module.js';
import { RegulatoryPermitModule } from './regulatory-permits/regulatory-permit.module.js';
import { SeatMapModule } from './seat-maps/seat-map.module.js';
import { TripModule } from './trips/trip.module.js';
import { TrackingModule } from './tracking/tracking.module.js';

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
        FinanceModule,
        TripModule,
        SeatMapModule,
        PricingModule,
        ReportingModule,
        ContentModule,
        MediaModule,
        BookingModule,
        PaymentModule,
        PassengerDocumentModule,
        ComplianceModule,
        BaggageModule,
        BorderModule,
        IncidentModule,
        CheckInModule,
        CrewModule,
        ManifestModule,
        RegulatoryPermitModule,
        DepartureReadinessModule,
        TrackingModule,
      ],
      controllers: options.extraControllers ?? [],
    };
  }
}
