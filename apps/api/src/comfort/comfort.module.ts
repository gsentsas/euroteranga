import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ComfortService } from './comfort.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [ComfortService],
  exports: [ComfortService],
})
export class ComfortModule {}
