import { AuthIdentityStatus, AuthRealm, AuthSessionRevocationReason } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { SessionService } from '../auth/session/session.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  assertMayActOn,
  assertNotLastPrivilegedAdmin,
  isAllowedStatusTransition,
  lockPrivilegedInvariants,
  permissionsOf,
} from './access-rules.js';
import { AuditService } from './audit.service.js';
import { AuthorizationErrors } from './authorization.errors.js';
import { AuthorizationService } from './authorization.service.js';

export interface AdminIdentityView {
  id: string;
  realm: AuthRealm;
  email: string;
  status: AuthIdentityStatus;
  emailVerifiedAt: Date | null;
  roles: string[];
  mfaEnabled: boolean;
  createdAt: Date;
}

/**
 * Administrative operations on identities: listing (STAFF/CREW), access
 * details, status changes and session revocation. Every mutation runs in one
 * transaction with its audit event.
 */
@Injectable()
export class IdentityAdministrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /** Minimal view only: never hashes, ciphertexts, tokens or recovery codes. */
  async list(options: {
    realm: 'staff' | 'crew';
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ items: AdminIdentityView[]; nextCursor: string | null }> {
    const take = Math.min(Math.max(options.limit, 1), 100);
    const rows = await this.database.client.authIdentity.findMany({
      take: take + 1,
      where: {
        realm: options.realm === 'staff' ? AuthRealm.STAFF : AuthRealm.CREW,
        ...(options.cursor ? { id: { lt: options.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      select: {
        id: true,
        realm: true,
        email: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
        mfaTotpCredential: { select: { enabledAt: true } },
        roleAssignments: { where: { revokedAt: null }, select: { roleKey: true } },
      },
    });
    const page = rows.slice(0, take);
    return {
      items: page.map(({ mfaTotpCredential, roleAssignments, ...identity }) => ({
        ...identity,
        roles: roleAssignments.map((assignment) => assignment.roleKey).sort(),
        mfaEnabled: Boolean(mfaTotpCredential?.enabledAt),
      })),
      nextCursor: rows.length > take ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async access(identityId: string) {
    const exists = await this.database.client.authIdentity.findUnique({
      where: { id: identityId },
      select: { id: true },
    });
    if (!exists) throw AuthorizationErrors.identityNotFound();
    return { identityId, ...(await this.authorization.snapshot(identityId)) };
  }

  /**
   * Allowed: ACTIVE→SUSPENDED|DISABLED, SUSPENDED→ACTIVE|DISABLED. Leaving
   * ACTIVE revokes every session and bumps authVersion; reactivation creates
   * no session (the user signs in again).
   */
  async setStatus(
    identityId: string,
    status: AuthIdentityStatus,
    actor: AuthPrincipal,
    reason?: string,
  ): Promise<{ status: AuthIdentityStatus }> {
    if (identityId === actor.identityId) throw AuthorizationErrors.selfModificationForbidden();
    await this.database.client.$transaction(async (tx) => {
      await lockPrivilegedInvariants(tx);
      const identity = await tx.authIdentity.findUnique({
        where: { id: identityId },
        select: { status: true },
      });
      if (!identity) throw AuthorizationErrors.identityNotFound();
      if (!isAllowedStatusTransition(identity.status, status)) {
        throw AuthorizationErrors.invalidStatusTransition();
      }
      await assertMayActOn(tx, await permissionsOf(tx, actor.identityId), identityId);
      if (identity.status === AuthIdentityStatus.ACTIVE) {
        await assertNotLastPrivilegedAdmin(tx, identityId);
      }

      // Conditional on the status read above: a concurrent change loses.
      const updated = await tx.authIdentity.updateMany({
        where: { id: identityId, status: identity.status },
        data: { status },
      });
      if (updated.count !== 1) throw AuthorizationErrors.invalidStatusTransition();
      if (status !== AuthIdentityStatus.ACTIVE) {
        await this.sessions.revokeAllForIdentity(
          tx,
          identityId,
          AuthSessionRevocationReason.ADMIN_ACTION,
        );
      }
      await this.audit.record(
        {
          actor,
          action: 'IDENTITY_STATUS_CHANGED',
          resourceType: 'auth_identity',
          resourceId: identityId,
          before: { status: identity.status },
          after: { status },
          ...(reason ? { metadata: { reason } } : {}),
        },
        tx,
      );
    });
    return { status };
  }

  /** Revokes every session of an identity and bumps its authVersion. */
  async revokeSessions(identityId: string, actor: AuthPrincipal, reason?: string): Promise<void> {
    await this.database.client.$transaction(async (tx) => {
      const exists = await tx.authIdentity.findUnique({
        where: { id: identityId },
        select: { id: true },
      });
      if (!exists) throw AuthorizationErrors.identityNotFound();
      await assertMayActOn(tx, await permissionsOf(tx, actor.identityId), identityId);
      await this.sessions.revokeAllForIdentity(
        tx,
        identityId,
        AuthSessionRevocationReason.ADMIN_ACTION,
      );
      await this.audit.record(
        {
          actor,
          action: 'SESSIONS_REVOKED_BY_ADMIN',
          resourceType: 'auth_identity',
          resourceId: identityId,
          ...(reason ? { metadata: { reason } } : {}),
        },
        tx,
      );
    });
  }
}
