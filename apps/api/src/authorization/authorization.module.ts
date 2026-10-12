import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuditService } from './audit.service.js';
import { AuthorizationGuard } from './authorization.guard.js';
import { AuthorizationService } from './authorization.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [AuthorizationService, AuthorizationGuard, AuditService],
  exports: [AuthorizationService, AuthorizationGuard, AuditService],
})
export class AuthorizationModule {}
