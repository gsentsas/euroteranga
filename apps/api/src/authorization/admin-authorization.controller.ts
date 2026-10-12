import { AuthIdentityStatus, AuthSessionRevocationReason } from '@euroteranga/database';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { CsrfGuard, AuthRequestGuard, SessionGuard } from '../auth/http/auth.guards.js';
import { AuthRealmRoute, CurrentPrincipal } from '../auth/http/request-context.js';
import { ZodValidationPipe } from '../auth/http/zod-validation.pipe.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { SessionService } from '../auth/session/session.service.js';
import { StaffProvisioningService } from '../auth/staff-provisioning/staff-provisioning.service.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from './audit.service.js';
import { AuthorizationGuard, RequirePermissions } from './authorization.guard.js';
import { AuthorizationErrors } from './authorization.errors.js';
import {
  IdentityStatusBody,
  identityStatusSchema,
  ReasonBody,
  reasonSchema,
  RoleMutationBody,
  roleMutationSchema,
  StaffInvitationBody,
  staffInvitationSchema,
} from './authorization.dto.js';
import { AuthorizationService } from './authorization.service.js';
import { PERMISSIONS } from './permissions.js';

@ApiTags('admin: authorization')
@Controller({ path: 'admin', version: '1' })
@AuthRealmRoute('staff')
@UseGuards(AuthRequestGuard, SessionGuard, AuthorizationGuard)
export class AdminAuthorizationController {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    private readonly provisioning: StaffProvisioningService,
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
  ) {}

  @Get('access/me')
  @RequirePermissions(PERMISSIONS.ROLE_READ)
  async myAccess(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.authorization.snapshot(principal.identityId);
  }

  @Get('roles')
  @RequirePermissions(PERMISSIONS.ROLE_READ)
  async roles() {
    const roles = await this.authorization.listRoles();
    return roles.map((role) => ({
      ...role,
      permissions: role.permissions.map((permission) => permission.permissionKey),
    }));
  }

  @Post('identities/:identityId/roles')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.ROLE_ASSIGN)
  @ApiBody({ type: RoleMutationBody })
  async grantRole(
    @Param('identityId') identityId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(roleMutationSchema))
    body: z.infer<typeof roleMutationSchema>,
  ) {
    return this.authorization.grantRole(identityId, body.roleKey, principal, body.reason);
  }

  @Post('identities/:identityId/roles/revoke')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.ROLE_ASSIGN)
  @ApiBody({ type: RoleMutationBody })
  async revokeRole(
    @Param('identityId') identityId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(roleMutationSchema))
    body: z.infer<typeof roleMutationSchema>,
  ): Promise<void> {
    await this.authorization.revokeRole(identityId, body.roleKey, principal, body.reason);
  }

  @Post('staff/invitations')
  @HttpCode(202)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.STAFF_PROVISION, PERMISSIONS.ROLE_ASSIGN)
  @ApiBody({ type: StaffInvitationBody })
  async inviteStaff(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(staffInvitationSchema))
    body: z.infer<typeof staffInvitationSchema>,
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
    @Param('identityId') identityId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ) {
    const result = await this.provisioning.authorizeMfaEnrollment(identityId, principal);
    return { expiresAt: result.expiresAt.toISOString() };
  }

  @Post('identities/:identityId/status')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.IDENTITY_STATUS_MANAGE)
  @ApiBody({ type: IdentityStatusBody })
  async setStatus(
    @Param('identityId') identityId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(identityStatusSchema))
    body: z.infer<typeof identityStatusSchema>,
  ) {
    const existing = await this.database.client.authIdentity.findUnique({
      where: { id: identityId },
      select: { id: true, status: true },
    });
    if (!existing) throw AuthorizationErrors.identityNotFound();

    await this.database.client.$transaction(async (tx) => {
      await tx.authIdentity.update({
        where: { id: identityId },
        data: { status: body.status as AuthIdentityStatus },
      });
      if (body.status !== 'ACTIVE') {
        await this.sessions.revokeAllForIdentity(
          tx,
          identityId,
          AuthSessionRevocationReason.ADMIN_ACTION,
        );
      }
      await this.audit.record(
        {
          actor: principal,
          action: 'IDENTITY_STATUS_CHANGED',
          resourceType: 'auth_identity',
          resourceId: identityId,
          before: { status: existing.status },
          after: { status: body.status },
          metadata: body.reason ? { reason: body.reason } : undefined,
        },
        tx,
      );
    });
    return { status: body.status };
  }

  @Post('identities/:identityId/sessions/revoke-all')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  @RequirePermissions(PERMISSIONS.SESSION_REVOKE_ANY)
  @ApiBody({ type: ReasonBody })
  async revokeSessions(
    @Param('identityId') identityId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(reasonSchema))
    body: z.infer<typeof reasonSchema>,
  ): Promise<void> {
    const exists = await this.database.client.authIdentity.findUnique({
      where: { id: identityId },
      select: { id: true },
    });
    if (!exists) throw AuthorizationErrors.identityNotFound();

    await this.database.client.$transaction(async (tx) => {
      await this.sessions.revokeAllForIdentity(
        tx,
        identityId,
        AuthSessionRevocationReason.ADMIN_ACTION,
      );
      await this.audit.record(
        {
          actor: principal,
          action: 'SESSIONS_REVOKED_BY_ADMIN',
          resourceType: 'auth_identity',
          resourceId: identityId,
          metadata: body.reason ? { reason: body.reason } : undefined,
        },
        tx,
      );
    });
  }

  @Get('audit')
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  @ApiOkResponse({ description: 'Newest privileged audit events first.' })
  auditEvents(@Query('limit') limit?: string) {
    const parsed = limit === undefined ? 50 : Number.parseInt(limit, 10);
    return this.audit.list(Number.isFinite(parsed) ? parsed : 50);
  }
}
