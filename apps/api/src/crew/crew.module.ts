import { Module } from '@nestjs/common';
import { BorderModule } from '../borders/border.module.js';
import { CheckInModule } from '../check-in/check-in.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IncidentModule } from '../incidents/incident.module.js';
import { TrackingModule } from '../tracking/tracking.module.js';
import { AdminCrewAssignmentController } from './admin-crew-assignment.controller.js';
import { CrewController } from './crew.controller.js';
import { CrewService } from './crew.service.js';

@Module({
  imports: [DatabaseModule, CheckInModule, TrackingModule, BorderModule, IncidentModule],
  controllers: [CrewController, AdminCrewAssignmentController],
  providers: [CrewService],
})
export class CrewModule {}
