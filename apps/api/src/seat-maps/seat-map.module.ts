import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminSeatMapController } from './admin-seat-map.controller.js';
import { SeatMapService } from './seat-map.service.js';

/**
 * Guards, AuthorizationService and AuditService come from the global
 * AuthorizationModule (which re-exports the single AuthModule instance).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminSeatMapController],
  providers: [SeatMapService],
  exports: [SeatMapService],
})
export class SeatMapModule {}
