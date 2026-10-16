import { Module } from '@nestjs/common';
import { CheckInModule } from '../check-in/check-in.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AdminCrewAssignmentController } from './admin-crew-assignment.controller.js';
import { CrewController } from './crew.controller.js';
import { CrewService } from './crew.service.js';

@Module({
  imports: [DatabaseModule, CheckInModule],
  controllers: [CrewController, AdminCrewAssignmentController],
  providers: [CrewService],
})
export class CrewModule {}
