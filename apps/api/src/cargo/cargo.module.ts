import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminCargoController } from './admin-cargo.controller.js';
import { CustomerCargoController } from './customer-cargo.controller.js';
import { CargoQuoteService } from './cargo-quote.service.js';
import { CargoTrackingService } from './cargo-tracking.service.js';
import { CargoService } from './cargo.service.js';
import { CustomerCargoService } from './customer-cargo.service.js';
import { PublicCargoTrackingController } from './public-cargo-tracking.controller.js';

/** CARGO-1: road-freight identity, assignment, capacity and immutable operational history. */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminCargoController, CustomerCargoController, PublicCargoTrackingController],
  providers: [CargoService, CustomerCargoService, CargoQuoteService, CargoTrackingService],
})
export class CargoModule {}
