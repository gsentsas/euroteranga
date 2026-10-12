import {
  AuthIdentityStatus,
  AuthRealm,
  Prisma,
  type DatabaseTransaction,
} from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig } from '../../auth/auth.config.js';
import { hashPassword } from '../../auth/crypto/password-hasher.js';
import {
  hashOpaqueToken,
  isWellFormedOpaqueToken,
  secureRandomToken,
} from '../../auth/crypto/tokens.js';
import { AuthErrors } from '../../auth/http/public-api-error.js';
import { displayEmail, normalizeEmail } from '../../auth/identity/email.js';
import { AuthMailer } from '../../auth/mail/auth-mailer.js';
import { checkPasswordPolicy } from '../../auth/password/password-policy.js';
import { RATE_LIMITS } from '../../auth/rate-limit/rate-limit.rules.js';
import { RateLimitService } from '../../auth/rate-limit/rate-limit.service.js';
import type { AuthPrincipal } from '../../auth/session/auth-principal.js';
import { DatabaseService } from '../../database/database.service.js';
import { assertMayActOn, lockPrivilegedInvariants, permissionsOf } from '../access-rules.js';
import { AuditService } from '../audit.service.js';
import { AuthorizationErrors } from '../authorization.errors.js';
import { PERMISSIONS } from '../permissions.js';

/**
 * Controlled STAFF provisioning (there is no public staff registration):
 *
 *   admin invites (email + STAFF role) → invitation mail (#token=...)
 *   → recipient sets a password → identity ACTIVE + StaffEnrollmentGrant
 *   → login → TOTP enrollment (requires the grant) → STAFF session.
 */
@Injectable()
export class StaffProvisioningService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly mailer: AuthMailer,
    private readonly audit: AuditService,
    private readonly rateLimits: RateLimitService,
  ) {}

  /**
   * Invites a new STAFF member, or re-issues the invitation of a still
   * pending one (the previous link stops working). Refused for an existing
   * non-pending account: its password and roles are never touched silently.
   */
  async invite(
    email: string,
    roleKey: string,
    actor: AuthPrincipal,
  ): Promise<{ identityId: string; expiresAt: Date }> {
    const normalizedEmail = normalizeEmail(email);
    const display = displayEmail(email);
    const token = secureRandomToken();
    const expiresAt = new Date(Date.now() + this.config.staffInvitationTtlMs);

    let identityId: string;
    try {
      identityId = await this.database.client.$transaction(async (tx) => {
        await lockPrivilegedInvariants(tx);
        const [role, actorPermissions] = await Promise.all([
          tx.authorizationRole.findUnique({
            where: { key: roleKey },
            select: {
              realm: true,
              privileged: true,
              permissions: { select: { permissionKey: true } },
            },
          }),
          permissionsOf(tx, actor.identityId),
        ]);
        if (!role) throw AuthorizationErrors.roleNotFound();
        if (role.realm !== AuthRealm.STAFF) throw AuthorizationErrors.roleRealmMismatch();
        if (role.privileged && !actorPermissions.has(PERMISSIONS.PRIVILEGED_MANAGE)) {
          throw AuthorizationErrors.forbidden();
        }
        if (role.permissions.some(({ permissionKey }) => !actorPermissions.has(permissionKey))) {
          throw AuthorizationErrors.forbidden();
        }

        const existing = await tx.authIdentity.findUnique({
          where: { realm_normalizedEmail: { realm: AuthRealm.STAFF, normalizedEmail } },
          select: { id: true, status: true, passwordCredential: { select: { identityId: true } } },
        });
        if (
          existing &&
          (existing.status !== AuthIdentityStatus.PENDING_VERIFICATION ||
            existing.passwordCredential)
        ) {
          throw AuthorizationErrors.staffAlreadyExists();
        }
        if (existing) await assertMayActOn(tx, actorPermissions, existing.id);

        const identity =
          existing ??
          (await tx.authIdentity.create({
            data: {
              realm: AuthRealm.STAFF,
              email: display,
              normalizedEmail,
              status: AuthIdentityStatus.PENDING_VERIFICATION,
            },
            select: { id: true },
          }));

        await issueInvitation(tx, identity.id, token, expiresAt, actor.identityId);
        const roleAdded = await ensureRole(tx, identity.id, roleKey, actor.identityId);

        await this.audit.record(
          {
            actor,
            action: 'STAFF_INVITED',
            resourceType: 'auth_identity',
            resourceId: identity.id,
            after: { roleKey, roleAdded, status: AuthIdentityStatus.PENDING_VERIFICATION },
            metadata: {
              reinvitation: Boolean(existing),
              invitationExpiresAt: expiresAt.toISOString(),
            },
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

    this.mailer.sendStaffInvitation(display, token, this.config.staffInvitationTtlMs);
    return { identityId, expiresAt };
  }

  /**
   * Consumes the invitation (single use, concurrent submissions: exactly one
   * succeeds), sets the Argon2id password, activates the identity and issues
   * the first-MFA-enrollment grant — in one transaction with its audit event.
   */
  async acceptInvitation(token: string, newPassword: string, ip: string): Promise<void> {
    await this.rateLimits.consume(RATE_LIMITS.staffInvitationIp, `ip:${ip}`);
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
    if (!policy.ok) throw AuthErrors.passwordPolicy(policy.message);
    const passwordHash = await hashPassword(newPassword);
    const grantExpiresAt = new Date(Date.now() + this.config.staffEnrollmentGrantTtlMs);

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
          realm: AuthRealm.STAFF,
          status: AuthIdentityStatus.PENDING_VERIFICATION,
        },
        data: { status: AuthIdentityStatus.ACTIVE, emailVerifiedAt: new Date() },
      });
      if (activated.count !== 1) throw AuthorizationErrors.invitationInvalid();

      await tx.passwordCredential.upsert({
        where: { identityId: record.identityId },
        create: { identityId: record.identityId, passwordHash },
        update: { passwordHash },
      });
      await issueEnrollmentGrant(tx, record.identityId, grantExpiresAt, record.createdByIdentityId);

      await this.audit.record(
        {
          action: 'STAFF_INVITATION_ACCEPTED',
          resourceType: 'auth_identity',
          resourceId: record.identityId,
          before: { status: AuthIdentityStatus.PENDING_VERIFICATION },
          after: { status: AuthIdentityStatus.ACTIVE },
          metadata: {
            invitedByIdentityId: record.createdByIdentityId,
            enrollmentGrantExpiresAt: grantExpiresAt.toISOString(),
          },
        },
        tx,
      );
    });
  }

  /**
   * Re-authorizes first-time TOTP enrollment for an ACTIVE STAFF identity
   * without MFA (e.g. the grant expired before the person enrolled).
   */
  async authorizeMfaEnrollment(
    identityId: string,
    actor: AuthPrincipal,
  ): Promise<{ expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.config.staffEnrollmentGrantTtlMs);
    await this.database.client.$transaction(async (tx) => {
      const identity = await tx.authIdentity.findUnique({
        where: { id: identityId },
        select: { realm: true, status: true, mfaTotpCredential: { select: { enabledAt: true } } },
      });
      if (!identity || identity.realm !== AuthRealm.STAFF) {
        throw AuthorizationErrors.identityNotFound();
      }
      if (identity.status !== AuthIdentityStatus.ACTIVE) {
        throw AuthorizationErrors.invalidStatusTransition();
      }
      if (identity.mfaTotpCredential?.enabledAt) throw AuthorizationErrors.mfaAlreadyEnabled();
      await assertMayActOn(tx, await permissionsOf(tx, actor.identityId), identityId);

      await issueEnrollmentGrant(tx, identityId, expiresAt, actor.identityId);
      await this.audit.record(
        {
          actor,
          action: 'STAFF_MFA_ENROLLMENT_AUTHORIZED',
          resourceType: 'auth_identity',
          resourceId: identityId,
          after: { enrollmentGrantExpiresAt: expiresAt.toISOString() },
        },
        tx,
      );
    });
    return { expiresAt };
  }
}

/** Supersedes the usable invitation of an identity and stores a new one (hash only). */
export async function issueInvitation(
  tx: DatabaseTransaction,
  identityId: string,
  token: string,
  expiresAt: Date,
  createdByIdentityId: string | null,
): Promise<void> {
  await tx.staffInvitation.updateMany({
    where: { identityId, consumedAt: null, invalidatedAt: null },
    data: { invalidatedAt: new Date() },
  });
  await tx.staffInvitation.create({
    data: { identityId, tokenHash: hashOpaqueToken(token), expiresAt, createdByIdentityId },
  });
}

/** Creates or renews the single first-enrollment grant of an identity. */
export async function issueEnrollmentGrant(
  tx: DatabaseTransaction,
  identityId: string,
  expiresAt: Date,
  issuedByIdentityId: string | null,
): Promise<void> {
  const data = { issuedByIdentityId, issuedAt: new Date(), expiresAt, consumedAt: null };
  await tx.staffEnrollmentGrant.upsert({
    where: { identityId },
    create: { identityId, ...data },
    update: data,
  });
}

/** Adds an active role assignment unless one already exists. */
export async function ensureRole(
  tx: DatabaseTransaction,
  identityId: string,
  roleKey: string,
  grantedByIdentityId: string | null,
): Promise<boolean> {
  const active = await tx.authorizationRoleAssignment.findFirst({
    where: { identityId, roleKey, revokedAt: null },
    select: { id: true },
  });
  if (active) return false;
  await tx.authorizationRoleAssignment.create({
    data: { identityId, roleKey, grantedByIdentityId, grantReason: 'staff provisioning' },
  });
  return true;
}
