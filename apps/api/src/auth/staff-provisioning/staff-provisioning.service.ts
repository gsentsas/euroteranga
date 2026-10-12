import {
  AuthIdentityStatus,
  AuthRealm,
  Prisma,
} from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../authorization/audit.service.js';
import { AuthorizationErrors } from '../../authorization/authorization.errors.js';
import { expectedRealmForRole } from '../../authorization/permissions.js';
import { DatabaseService } from '../../database/database.service.js';
import { AUTH_CONFIG, type AuthConfig } from '../auth.config.js';
import { hashPassword } from '../crypto/password-hasher.js';
import {
  hashOpaqueToken,
  isWellFormedOpaqueToken,
  secureRandomToken,
} from '../crypto/tokens.js';
import { displayEmail, normalizeEmail } from '../identity/email.js';
import { AuthMailer } from '../mail/auth-mailer.js';
import { checkPasswordPolicy } from '../password/password-policy.js';
import type { AuthPrincipal } from '../session/auth-principal.js';

const STAFF_ENROLLMENT_GRANT_TTL_MS = 30 * 60_000;

@Injectable()
export class StaffProvisioningService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly mailer: AuthMailer,
    private readonly audit: AuditService,
  ) {}

  async invite(email: string, roleKey: string, actor: AuthPrincipal) {
    if (expectedRealmForRole(roleKey) !== AuthRealm.STAFF) {
      throw AuthorizationErrors.invalidStaffTarget();
    }
    const role = await this.database.client.authorizationRole.findUnique({
      where: { key: roleKey },
      select: { key: true },
    });
    if (!role) throw AuthorizationErrors.roleNotFound();

    const normalizedEmail = normalizeEmail(email);
    const display = displayEmail(email);
    const token = secureRandomToken();
    const expiresAt = new Date(Date.now() + this.config.emailVerificationTtlMs);

    let identityId: string;
    try {
      identityId = await this.database.client.$transaction(async (tx) => {
        const existing = await tx.authIdentity.findUnique({
          where: {
            realm_normalizedEmail: {
              realm: AuthRealm.STAFF,
              normalizedEmail,
            },
          },
          select: {
            id: true,
            status: true,
            passwordCredential: { select: { identityId: true } },
          },
        });
        if (
          existing &&
          (existing.passwordCredential || existing.status === AuthIdentityStatus.ACTIVE)
        ) {
          throw AuthorizationErrors.staffAlreadyExists();
        }

        const identity = existing
          ? await tx.authIdentity.update({
              where: { id: existing.id },
              data: { email: display },
              select: { id: true },
            })
          : await tx.authIdentity.create({
              data: {
                realm: AuthRealm.STAFF,
                email: display,
                normalizedEmail,
                status: AuthIdentityStatus.PENDING_VERIFICATION,
              },
              select: { id: true },
            });

        await tx.staffInvitation.updateMany({
          where: { identityId: identity.id, consumedAt: null, invalidatedAt: null },
          data: { invalidatedAt: new Date() },
        });
        await tx.staffInvitation.create({
          data: {
            identityId: identity.id,
            tokenHash: hashOpaqueToken(token),
            expiresAt,
            createdByIdentityId: actor.identityId,
          },
        });

        const activeRole = await tx.authorizationRoleAssignment.findFirst({
          where: { identityId: identity.id, roleKey, revokedAt: null },
          select: { id: true },
        });
        if (!activeRole) {
          await tx.authorizationRoleAssignment.create({
            data: {
              identityId: identity.id,
              roleKey,
              grantedByIdentityId: actor.identityId,
              reason: 'staff invitation',
            },
          });
        }

        await this.audit.record(
          {
            actor,
            action: 'STAFF_INVITED',
            resourceType: 'auth_identity',
            resourceId: identity.id,
            after: { roleKey, status: AuthIdentityStatus.PENDING_VERIFICATION },
          },
          tx,
        );
        return identity.id;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw AuthorizationErrors.staffAlreadyExists();
      }
      throw error;
    }

    this.mailer.sendStaffInvitation(display, token, this.config.emailVerificationTtlMs);
    return { identityId, expiresAt };
  }

  async acceptInvitation(token: string, newPassword: string): Promise<void> {
    if (!isWellFormedOpaqueToken(token)) throw AuthorizationErrors.invitationInvalid();

    const record = await this.database.client.staffInvitation.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: {
        id: true,
        identityId: true,
        expiresAt: true,
        consumedAt: true,
        invalidatedAt: true,
        createdByIdentityId: true,
        identity: { select: { email: true, status: true, realm: true } },
      },
    });
    if (
      !record ||
      record.consumedAt ||
      record.invalidatedAt ||
      record.expiresAt <= new Date() ||
      record.identity.realm !== AuthRealm.STAFF ||
      record.identity.status !== AuthIdentityStatus.PENDING_VERIFICATION
    ) {
      throw AuthorizationErrors.invitationInvalid();
    }

    const policy = checkPasswordPolicy(newPassword, { email: record.identity.email });
    if (!policy.ok) {
      const { AuthErrors } = await import('../http/public-api-error.js');
      throw AuthErrors.passwordPolicy(policy.message);
    }
    const passwordHash = await hashPassword(newPassword);
    const enrollmentExpiresAt = new Date(Date.now() + STAFF_ENROLLMENT_GRANT_TTL_MS);

    await this.database.client.$transaction(async (tx) => {
      const consumed = await tx.staffInvitation.updateMany({
        where: {
          id: record.id,
          consumedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) throw AuthorizationErrors.invitationInvalid();

      const activated = await tx.authIdentity.updateMany({
        where: {
          id: record.identityId,
          status: AuthIdentityStatus.PENDING_VERIFICATION,
          realm: AuthRealm.STAFF,
        },
        data: {
          status: AuthIdentityStatus.ACTIVE,
          emailVerifiedAt: new Date(),
        },
      });
      if (activated.count !== 1) throw AuthorizationErrors.invitationInvalid();

      await tx.passwordCredential.upsert({
        where: { identityId: record.identityId },
        create: { identityId: record.identityId, passwordHash },
        update: { passwordHash },
      });

      await tx.staffEnrollmentGrant.upsert({
        where: { identityId: record.identityId },
        create: {
          identityId: record.identityId,
          issuedByIdentityId: record.createdByIdentityId,
          expiresAt: enrollmentExpiresAt,
        },
        update: {
          issuedByIdentityId: record.createdByIdentityId,
          issuedAt: new Date(),
          expiresAt: enrollmentExpiresAt,
          consumedAt: null,
        },
      });

      await this.audit.record(
        {
          action: 'STAFF_INVITATION_ACCEPTED',
          resourceType: 'auth_identity',
          resourceId: record.identityId,
          after: { status: AuthIdentityStatus.ACTIVE },
        },
        tx,
      );
    });
  }

  async authorizeMfaEnrollment(identityId: string, actor: AuthPrincipal) {
    const identity = await this.database.client.authIdentity.findUnique({
      where: { id: identityId },
      select: {
        id: true,
        realm: true,
        status: true,
        mfaTotpCredential: { select: { enabledAt: true } },
      },
    });
    if (
      !identity ||
      identity.realm !== AuthRealm.STAFF ||
      identity.status !== AuthIdentityStatus.ACTIVE
    ) {
      throw AuthorizationErrors.identityNotFound();
    }
    if (identity.mfaTotpCredential?.enabledAt) {
      throw AuthorizationErrors.mfaAlreadyEnabled();
    }

    const expiresAt = new Date(Date.now() + STAFF_ENROLLMENT_GRANT_TTL_MS);
    await this.database.client.$transaction(async (tx) => {
      await tx.staffEnrollmentGrant.upsert({
        where: { identityId },
        create: {
          identityId,
          issuedByIdentityId: actor.identityId,
          expiresAt,
        },
        update: {
          issuedByIdentityId: actor.identityId,
          issuedAt: new Date(),
          expiresAt,
          consumedAt: null,
        },
      });
      await this.audit.record(
        {
          actor,
          action: 'STAFF_MFA_ENROLLMENT_AUTHORIZED',
          resourceType: 'auth_identity',
          resourceId: identityId,
          after: { expiresAt: expiresAt.toISOString() },
        },
        tx,
      );
    });
    return { expiresAt };
  }
}
