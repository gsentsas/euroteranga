import { Module } from '@nestjs/common';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AdminBoardingController } from './admin-boarding.controller.js';
import { AdminCheckInController } from './admin-check-in.controller.js';
import { BoardingService } from './boarding.service.js';
import { CheckInService } from './check-in.service.js';
import { CustomerCheckInController } from './customer-check-in.controller.js';

/**
 * PR-14 passenger check-in and boarding of one BookingPassenger. Manifests
 * (PR-15), trip readiness (PR-17) and the offline Crew app (PR-18) are not
 * part of it.
 */
@Module({
  imports: [DatabaseModule, ComplianceModule],
  controllers: [CustomerCheckInController, AdminCheckInController, AdminBoardingController],
  providers: [CheckInService, BoardingService],
  exports: [CheckInService],
})
export class CheckInModule {}
