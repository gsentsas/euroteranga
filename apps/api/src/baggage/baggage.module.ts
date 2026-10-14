import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminBaggageController } from './admin-baggage.controller.js';
import { BaggageService } from './baggage.service.js';
import { CustomerBaggageController } from './customer-baggage.controller.js';

/** PR-13 baggage identity, exact weight and immutable operational history. */
@Module({
  imports: [DatabaseModule],
  controllers: [CustomerBaggageController, AdminBaggageController],
  providers: [BaggageService],
})
export class BaggageModule {}
