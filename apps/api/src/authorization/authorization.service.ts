import { Prisma } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from './audit.service.js';
import { AuthorizationErrors } from './authorization.errors.js';
import { expectedRealmForRole } from './permissions.js';

export interface AuthorizationSnapshot {
  roles: string[];
  permissions: string[];
}

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
        role: {
          select: {
            key: true,
            permissions: { select: { permissionKey: true } },
          },
        },
      },
    });

    const roles = [...new Set(assignments.map((assignment) => assignment.role.key))].sort();
    const permissions = [
      ...new Set(
        assignments.flatMap((assignment) =>
          assignment.role.permissions.map((permission) => permission.permissionKey),
        ),
      ),
    ].sort();

    return { roles, permissions };
  }

  async hasAll(identityId: string, required: readonly string[]): Promise<boolean> {
    if (required.length === 0) return true;
    const { permissions } = await this.snapshot(identityId);
    const effective = new Set(permissions);
    return required.every((permission) => effective.has(permission));
  }

  async listRoles() {
    return this.database.client.authorizationRole.findMany({
      orderBy: { key: 'asc' },
      select: {
        key: true,
        name: true,
        description: true,
        system: true,
        permissions: {
          orderBy: { permissionKey: 'asc' },
          select: { permissionKey: true },
        },
      },
    });
  }

  async grantRole(
    identityId: string,
    roleKey: string,
    actor: AuthPrincipal,
    reason?: string,
  ) {
    const [identity, role] = await Promise.all([
      this.database.client.authIdentity.findUnique({
        where: { id: identityId },
        select: { id: true, realm: true },
      }),
      this.database.client.authorizationRole.findUnique({
        where: { key: roleKey },
        select: { key: true },
      }),
    ]);
    if (!identity) throw AuthorizationErrors.identityNotFound();
    if (!role) throw AuthorizationErrors.roleNotFound();
    if (identity.realm !== expectedRealmForRole(roleKey)) {
      throw AuthorizationErrors.invalidStaffTarget();
    }

    try {
      return await this.database.client.$transaction(async (tx) => {
        const assignment = await tx.authorizationRoleAssignment.create({
          data: {
            identityId,
            roleKey,
            grantedByIdentityId: actor.identityId,
            ...(reason ? { reason } : {}),
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
            metadata: reason ? { reason } : undefined,
          },
          tx,
        );
        return assignment;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw AuthorizationErrors.roleAlreadyAssigned();
      }
      throw error;
    }
  }

  async revokeRole(
    identityId: string,
    roleKey: string,
    actor: AuthPrincipal,
    reason?: string,
  ): Promise<void> {
    await this.database.client.$transaction(async (tx) => {
      const result = await tx.authorizationRoleAssignment.updateMany({
        where: { identityId, roleKey, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedByIdentityId: actor.identityId,
          ...(reason ? { reason } : {}),
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
          metadata: reason ? { reason } : undefined,
        },
        tx,
      );
    });
  }
}
