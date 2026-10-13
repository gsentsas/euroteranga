import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminPricingController } from './admin-pricing.controller.js';
import { FareResolutionService } from './fare-resolution.service.js';
import { PricingService } from './pricing.service.js';

/**
 * Guards, AuthorizationService and AuditService come from the global
 * AuthorizationModule (which re-exports the single AuthModule instance).
 * FareResolutionService is exported for the trip fare endpoint.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminPricingController],
  providers: [PricingService, FareResolutionService],
  exports: [PricingService, FareResolutionService],
})
export class PricingModule {}
