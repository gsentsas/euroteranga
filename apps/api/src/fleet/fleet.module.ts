import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminFleetController } from './admin-fleet.controller.js';
import { FleetService } from './fleet.service.js';

/**
 * Guards, AuthorizationService and AuditService come from the global
 * AuthorizationModule (which re-exports the single AuthModule instance).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminFleetController],
  providers: [FleetService],
  exports: [FleetService],
})
export class FleetModule {}
