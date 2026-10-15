import { Module } from '@nestjs/common';
import { CheckInModule } from '../check-in/check-in.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DepartureReadinessController } from './departure-readiness.controller.js';
import { DepartureReadinessService } from './departure-readiness.service.js';

/** PR-17 whole-trip readiness and dispatch. PR-18 owns Crew/offline mechanics. */
@Module({
  imports: [DatabaseModule, CheckInModule],
  controllers: [DepartureReadinessController],
  providers: [DepartureReadinessService],
  exports: [DepartureReadinessService],
})
export class DepartureReadinessModule {}
