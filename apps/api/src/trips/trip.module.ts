import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminTripController } from './admin-trip.controller.js';
import { TripService } from './trip.service.js';

/**
 * Guards, AuthorizationService and AuditService come from the global
 * AuthorizationModule (which re-exports the single AuthModule instance).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminTripController],
  providers: [TripService],
  exports: [TripService],
})
export class TripModule {}
