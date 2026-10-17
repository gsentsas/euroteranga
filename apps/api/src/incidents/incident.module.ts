import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { PassengerDocumentModule } from '../passenger-documents/passenger-document.module.js';
import { AdminIncidentController } from './admin-incident.controller.js';
import { CrewIncidentController } from './crew-incident.controller.js';
import { IncidentService } from './incident.service.js';

@Module({
  imports: [DatabaseModule, PassengerDocumentModule],
  controllers: [AdminIncidentController, CrewIncidentController],
  providers: [IncidentService],
  exports: [IncidentService],
})
export class IncidentModule {}
