import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminCargoController } from './admin-cargo.controller.js';
import { CargoQuoteService } from './cargo-quote.service.js';
import { CargoService } from './cargo.service.js';

/** CARGO-1: road-freight identity, assignment, capacity and immutable operational history. */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminCargoController],
  providers: [CargoService, CargoQuoteService],
})
export class CargoModule {}
