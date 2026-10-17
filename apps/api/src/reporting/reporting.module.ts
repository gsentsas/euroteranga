import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminReportingController } from './admin-reporting.controller.js';
import { ReportingService } from './reporting.service.js';

/** Guards and AuthorizationService are provided by the global AuthorizationModule. */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminReportingController],
  providers: [ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}
