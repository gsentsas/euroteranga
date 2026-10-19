import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminFleetController } from './admin-fleet.controller.js';
import { FleetService } from './fleet.service.js';
import { PublicFleetController } from './public-fleet.controller.js';

/**
 * Guards, AuthorizationService and AuditService come from the global
 * AuthorizationModule (which re-exports the single AuthModule instance).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminFleetController, PublicFleetController],
  providers: [FleetService],
  exports: [FleetService],
})
export class FleetModule {}
