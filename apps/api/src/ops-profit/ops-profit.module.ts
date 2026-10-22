import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminOpsProfitController } from './admin-ops-profit.controller.js';
import { OpsProfitService } from './ops-profit.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AdminOpsProfitController],
  providers: [OpsProfitService],
})
export class OpsProfitModule {}
