import { AuthIdentityStatus } from '@euroteranga/database';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { ErrorBody } from '../auth/dto/auth.dto.js';
import { AuthRequestGuard, CsrfGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from './audit.service.js';
import { AuthorizationGuard, RequirePermissions } from './authorization.guard.js';
import {
  AccessResponse,
  auditListQuerySchema,
  IdentityStatusBody,
  identityListQuerySchema,
  identityStatusSchema,
  ReasonBody,
  reasonSchema,
  RoleMutationBody,
  roleMutationSchema,
  StaffInvitationBody,
  staffInvitationSchema,
} from './authorization.dto.js';
import { AuthorizationService } from './authorization.service.js';
import { IdentityAdministrationService } from './identity-administration.service.js';
import { PERMISSIONS } from './permissions.js';
import { StaffProvisioningService } from './provisioning/staff-provisioning.service.js';

const uuid = new ParseUUIDPipe({ version: '7' });

/**
 * Administration API (STAFF realm). Every action requires a STAFF session
 * plus ops.access plus its own permission(s), checked against the database;
 * every mutation also requires a CSRF token and is audited transactionally.
 */
@ApiTags('admin: authorization')
@ApiUnauthorizedResponse({ type: ErrorBody })
@ApiForbiddenResponse({ type: ErrorBody, description: 'Missing permission, origin or CSRF token' })
@Controller({ path: 'admin', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
@RequirePermissions(PERMISSIONS.OPS_ACCESS)
export class AdminAuthorizationController {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly identities: IdentityAdministrationService,
    private readonly provisioning: StaffProvisioningService,
    private readonly audit: AuditService,
  ) {}

  @Get('roles')
  @RequirePermissions(PERMISSIONS.ROLE_READ)
  roles() {
    return this.authorization.listRoles();
  }

  @Get('identities')
  @RequirePermissions(PERMISSIONS.IDENTITY_READ)
  listIdentities(
    @Query(new ZodValidationPipe(identityListQuerySchema))
    query: z.infer<typeof identityListQuerySchema>,
  ) {
    return this.identities.list(query);
  }

  @Get('identities/:identityId/access')
  @RequirePermissions(PERMISSIONS.IDENTITY_READ, PERMISSIONS.ROLE_READ)
  identityAccess(@Param('identityId', uuid) identityId: string) {
    return this.identities.access(identityId);
  }

  @Post('identities/:identityId/roles')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.ROLE_ASSIGN)
  @ApiBody({ type: RoleMutationBody })
  grantRole(
    @Param('identityId', uuid) identityId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(roleMutationSchema)) body: z.infer<typeof roleMutationSchema>,
  ) {
    return this.authorization.grantRole(identityId, body.roleKey, principal, body.reason);
  }

  @Post('identities/:identityId/roles/revoke')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.ROLE_ASSIGN)
  @ApiBody({ type: RoleMutationBody })
  async revokeRole(
    @Param('identityId', uuid) identityId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(roleMutationSchema)) body: z.infer<typeof roleMutationSchema>,
  ): Promise<void> {
    await this.authorization.revokeRole(identityId, body.roleKey, principal, body.reason);
  }

  @Post('identities/:identityId/status')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.IDENTITY_STATUS_MANAGE)
  @ApiBody({ type: IdentityStatusBody })
  setStatus(
    @Param('identityId', uuid) identityId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(identityStatusSchema)) body: z.infer<typeof identityStatusSchema>,
  ) {
    return this.identities.setStatus(
      identityId,
      AuthIdentityStatus[body.status],
      principal,
      body.reason,
    );
  }

  @Post('identities/:identityId/sessions/revoke-all')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.SESSION_REVOKE_ANY)
  @ApiBody({ type: ReasonBody })
  async revokeSessions(
    @Param('identityId', uuid) identityId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
  ): Promise<void> {
    await this.identities.revokeSessions(identityId, principal, body.reason);
  }

  @Post('staff/invitations')
  @HttpCode(202)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.STAFF_PROVISION, PERMISSIONS.ROLE_ASSIGN)
  @ApiBody({ type: StaffInvitationBody })
  async inviteStaff(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(staffInvitationSchema)) body: z.infer<typeof staffInvitationSchema>,
  ) {
    const result = await this.provisioning.invite(body.email, body.roleKey, principal);
    return {
      status: 'INVITATION_SENT',
      identityId: result.identityId,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  @Post('staff/:identityId/mfa/enrollment-authorization')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.MFA_ENROLLMENT_AUTHORIZE)
  async authorizeMfa(
    @Param('identityId', uuid) identityId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ) {
    const result = await this.provisioning.authorizeMfaEnrollment(identityId, principal);
    return { expiresAt: result.expiresAt.toISOString() };
  }

  @Get('audit')
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  @ApiOkResponse({ description: 'Newest privileged audit events first (keyset pagination).' })
  auditEvents(
    @Query(new ZodValidationPipe(auditListQuerySchema)) query: z.infer<typeof auditListQuerySchema>,
  ) {
    return this.audit.list(query);
  }
}

/**
 * The caller's own roles and permissions, read from the database. Any STAFF
 * session may read its own access (the OPS UI uses it for display only; the
 * API re-checks every action).
 */
@ApiTags('admin: authorization')
@ApiUnauthorizedResponse({ type: ErrorBody })
@Controller({ path: 'admin/access', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard)
export class AdminAccessController {
  constructor(private readonly authorization: AuthorizationService) {}

  @Get('me')
  @ApiOkResponse({ type: AccessResponse })
  myAccess(@CurrentPrincipal() principal: AuthPrincipal): Promise<AccessResponse> {
    return this.authorization.snapshot(principal.identityId);
  }
}
