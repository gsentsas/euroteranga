import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminBorderController } from './admin-border.controller.js';
import { BorderService } from './border.service.js';
import { CrewBorderController } from './crew-border.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AdminBorderController, CrewBorderController],
  providers: [BorderService],
  exports: [BorderService],
})
export class BorderModule {}
