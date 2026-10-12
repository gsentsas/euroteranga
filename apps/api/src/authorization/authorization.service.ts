import { AuthIdentityStatus, Prisma } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { DatabaseService } from '../database/database.service.js';
import {
  assertMayActOn,
  assertNotLastPrivilegedAdmin,
  lockPrivilegedInvariants,
  permissionsOf,
} from './access-rules.js';
import { AuditService } from './audit.service.js';
import { AuthorizationErrors } from './authorization.errors.js';
import { PERMISSIONS } from './permissions.js';

export interface AuthorizationSnapshot {
  roles: string[];
  permissions: string[];
}

/**
 * Role-based authorization. Decisions are always computed from the database
 * at request time — never cached in the session — so a revoked role stops
 * granting anything on the very next request.
 */
@Injectable()
export class AuthorizationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async snapshot(identityId: string): Promise<AuthorizationSnapshot> {
    const assignments = await this.database.client.authorizationRoleAssignment.findMany({
      where: { identityId, revokedAt: null },
      select: {
        roleKey: true,
        role: { select: { permissions: { select: { permissionKey: true } } } },
      },
    });
    return {
      roles: [...new Set(assignments.map((assignment) => assignment.roleKey))].sort(),
      permissions: [
        ...new Set(
          assignments.flatMap((assignment) =>
            assignment.role.permissions.map((permission) => permission.permissionKey),
          ),
        ),
      ].sort(),
    };
  }

  async hasAll(identityId: string, required: readonly string[]): Promise<boolean> {
    if (required.length === 0) return false;
    const { permissions } = await this.snapshot(identityId);
    const effective = new Set(permissions);
    return required.every((permission) => effective.has(permission));
  }

  /** Read-only catalogue of system roles. */
  async listRoles() {
    const roles = await this.database.client.authorizationRole.findMany({
      orderBy: { key: 'asc' },
      select: {
        key: true,
        name: true,
        description: true,
        realm: true,
        privileged: true,
        system: true,
        permissions: { orderBy: { permissionKey: 'asc' }, select: { permissionKey: true } },
      },
    });
    return roles.map((role) => ({
      ...role,
      permissions: role.permissions.map((permission) => permission.permissionKey),
    }));
  }

  /**
   * Grants a role. Refused when: the actor targets itself; the role's realm
   * differs from the identity's; the role carries a permission the actor does
   * not hold; the role (or the target) is privileged and the actor lacks
   * privileged.manage; the identity is disabled; the role is already active.
   */
  async grantRole(identityId: string, roleKey: string, actor: AuthPrincipal, reason?: string) {
    if (identityId === actor.identityId) throw AuthorizationErrors.selfModificationForbidden();
    try {
      return await this.database.client.$transaction(async (tx) => {
        await lockPrivilegedInvariants(tx);
        const [identity, role, actorPermissions] = await Promise.all([
          tx.authIdentity.findUnique({
            where: { id: identityId },
            select: { realm: true, status: true },
          }),
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
        if (!identity) throw AuthorizationErrors.identityNotFound();
        if (!role) throw AuthorizationErrors.roleNotFound();
        if (identity.realm !== role.realm) throw AuthorizationErrors.roleRealmMismatch();
        if (identity.status === AuthIdentityStatus.DISABLED) {
          throw AuthorizationErrors.invalidStatusTransition();
        }
        if (role.privileged && !actorPermissions.has(PERMISSIONS.PRIVILEGED_MANAGE)) {
          throw AuthorizationErrors.forbidden();
        }
        // No privilege escalation: an actor cannot hand out what it lacks.
        if (role.permissions.some(({ permissionKey }) => !actorPermissions.has(permissionKey))) {
          throw AuthorizationErrors.forbidden();
        }
        await assertMayActOn(tx, actorPermissions, identityId);

        const assignment = await tx.authorizationRoleAssignment.create({
          data: {
            identityId,
            roleKey,
            grantedByIdentityId: actor.identityId,
            ...(reason ? { grantReason: reason } : {}),
          },
          select: { id: true, identityId: true, roleKey: true, grantedAt: true },
        });
        await this.audit.record(
          {
            actor,
            action: 'ROLE_GRANTED',
            resourceType: 'auth_identity',
            resourceId: identityId,
            after: { roleKey },
            ...(reason ? { metadata: { reason } } : {}),
          },
          tx,
        );
        return assignment;
      });
    } catch (error) {
      // Concurrent grant of the same role: the partial unique index lets one
      // win; the other transaction (and its audit event) is rolled back.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw AuthorizationErrors.roleAlreadyAssigned();
      }
      throw error;
    }
  }

  /**
   * Closes an active assignment (history kept). Same actor restrictions as
   * grants, plus the last usable privileged administrator cannot lose the
   * privileged role.
   */
  async revokeRole(identityId: string, roleKey: string, actor: AuthPrincipal, reason?: string) {
    if (identityId === actor.identityId) throw AuthorizationErrors.selfModificationForbidden();
    await this.database.client.$transaction(async (tx) => {
      await lockPrivilegedInvariants(tx);
      const [role, actorPermissions] = await Promise.all([
        tx.authorizationRole.findUnique({
          where: { key: roleKey },
          select: { privileged: true, permissions: { select: { permissionKey: true } } },
        }),
        permissionsOf(tx, actor.identityId),
      ]);
      if (!role) throw AuthorizationErrors.roleNotFound();
      if (role.privileged && !actorPermissions.has(PERMISSIONS.PRIVILEGED_MANAGE)) {
        throw AuthorizationErrors.forbidden();
      }
      if (role.permissions.some(({ permissionKey }) => !actorPermissions.has(permissionKey))) {
        throw AuthorizationErrors.forbidden();
      }
      await assertMayActOn(tx, actorPermissions, identityId);
      if (role.privileged) await assertNotLastPrivilegedAdmin(tx, identityId);

      const result = await tx.authorizationRoleAssignment.updateMany({
        where: { identityId, roleKey, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedByIdentityId: actor.identityId,
          ...(reason ? { revocationReason: reason } : {}),
        },
      });
      if (result.count !== 1) throw AuthorizationErrors.roleNotAssigned();
      await this.audit.record(
        {
          actor,
          action: 'ROLE_REVOKED',
          resourceType: 'auth_identity',
          resourceId: identityId,
          before: { roleKey },
          ...(reason ? { metadata: { reason } } : {}),
        },
        tx,
      );
    });
  }
}
