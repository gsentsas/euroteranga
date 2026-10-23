import { Module } from '@nestjs/common';
import { ComfortModule } from '../comfort/comfort.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AdminTrackingController } from './admin-tracking.controller.js';
import { CrewTrackingController } from './crew-tracking.controller.js';
import { PublicTrackingController } from './public-tracking.controller.js';
import { GPS_PROVIDER } from './providers/gps-provider.js';
import { UnavailableGpsProvider } from './providers/unavailable-gps.provider.js';
import { TrackingService } from './tracking.service.js';

@Module({
  imports: [DatabaseModule, ComfortModule],
  controllers: [AdminTrackingController, CrewTrackingController, PublicTrackingController],
  providers: [TrackingService, { provide: GPS_PROVIDER, useClass: UnavailableGpsProvider }],
  exports: [TrackingService],
})
export class TrackingModule {}
