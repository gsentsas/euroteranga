import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { AdminTripController } from './admin-trip.controller.js';
import { TripCostService } from './trip-cost.service.js';
import { TripService } from './trip.service.js';

/**
 * Guards, AuthorizationService and AuditService come from the global
 * AuthorizationModule (which re-exports the single AuthModule instance).
 */
@Module({
  imports: [DatabaseModule, PricingModule],
  controllers: [AdminTripController],
  providers: [TripService, TripCostService],
  exports: [TripService],
})
export class TripModule {}
