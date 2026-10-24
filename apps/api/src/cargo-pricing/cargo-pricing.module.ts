import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminCargoPricingController } from './admin-cargo-pricing.controller.js';
import { CargoPricingService } from './cargo-pricing.service.js';
import { PublicCargoPricingController } from './public-cargo-pricing.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AdminCargoPricingController, PublicCargoPricingController],
  providers: [CargoPricingService],
  exports: [CargoPricingService],
})
export class CargoPricingModule {}
