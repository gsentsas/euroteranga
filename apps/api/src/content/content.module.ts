import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AdminContentController } from './admin-content.controller.js';
import { ContentService } from './content.service.js';
import { PublicContentController } from './public-content.controller.js';

/**
 * Guards, AuthorizationService and AuditService come from the global
 * AuthorizationModule (which re-exports the single AuthModule instance).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminContentController, PublicContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
