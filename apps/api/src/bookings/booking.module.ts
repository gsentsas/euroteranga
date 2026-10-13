import type { ApiEnv } from '@euroteranga/config';
import { Module } from '@nestjs/common';
import { API_ENV } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AdminBookingController } from './admin-booking.controller.js';
import { BOOKING_CONFIG, buildBookingConfig } from './booking.config.js';
import { BookingService } from './booking.service.js';
import { CustomerBookingController } from './customer-booking.controller.js';
import { PublicBookingController } from './public-booking.controller.js';
import { PublicBookingService } from './public-booking.service.js';

/**
 * Guards, AuthorizationService and AuditService come from the global
 * AuthorizationModule (which re-exports the single AuthModule instance).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [PublicBookingController, CustomerBookingController, AdminBookingController],
  providers: [
    { provide: BOOKING_CONFIG, useFactory: buildBookingConfig, inject: [API_ENV] },
    BookingService,
    PublicBookingService,
  ],
})
export class BookingModule {}
