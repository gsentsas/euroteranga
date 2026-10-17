import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { PassengerDocumentModule } from '../passenger-documents/passenger-document.module.js';
import { AdminFinanceController } from './admin-finance.controller.js';
import { FinanceService } from './finance.service.js';

@Module({
  imports: [DatabaseModule, PassengerDocumentModule],
  controllers: [AdminFinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
