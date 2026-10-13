import { Module, type DynamicModule } from '@nestjs/common';
import { AuthModule, type AuthModuleOptions } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import {
  AdminAccessController,
  AdminAuthorizationController,
} from './admin-authorization.controller.js';
import { AuditService } from './audit.service.js';
import { AuthorizationGuard } from './authorization.guard.js';
import { AuthorizationService } from './authorization.service.js';
import { IdentityAdministrationService } from './identity-administration.service.js';
import { StaffInvitationController } from './provisioning/staff-invitation.controller.js';
import { StaffProvisioningService } from './provisioning/staff-provisioning.service.js';

/**
 * Authorization (RBAC), privileged audit trail and STAFF provisioning.
 * Depends on AuthModule (sessions, guards, mail, rate limits); AuthModule
 * does not depend on it.
 */
@Module({})
export class AuthorizationModule {
  static register(authOptions: AuthModuleOptions = {}): DynamicModule {
    return {
      module: AuthorizationModule,
      global: true,
      imports: [DatabaseModule, AuthModule.register(authOptions)],
      controllers: [AdminAuthorizationController, AdminAccessController, StaffInvitationController],
      providers: [
        AuthorizationService,
        AuthorizationGuard,
        AuditService,
        IdentityAdministrationService,
        StaffProvisioningService,
      ],
      // Cross-cutting guards and audit are shared by business modules. The
      // configured AuthModule is re-exported so it is still instantiated once.
      exports: [AuthModule, AuthorizationService, AuthorizationGuard, AuditService],
    };
  }
}
