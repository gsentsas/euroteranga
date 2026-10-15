import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminRegulatoryPermitController } from './admin-regulatory-permit.controller.js';
import { RegulatoryPermitService } from './regulatory-permit.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AdminRegulatoryPermitController],
  providers: [RegulatoryPermitService],
  exports: [RegulatoryPermitService],
})
export class RegulatoryPermitModule {}
