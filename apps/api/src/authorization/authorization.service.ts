import { AuthRealm, Prisma } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { AuthorizationErrors } from './authorization.errors.js';
import type { PermissionKey } from './permissions.js';

export interface AuthorizationSnapshot {
  roles: string[];
  permissions: string[];
}

@Injectable()
export class AuthorizationService {
  constructor(private readonly database: DatabaseService) {}

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
    actorIdentityId: string,
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
    if (identity.realm !== AuthRealm.STAFF) throw AuthorizationErrors.invalidStaffTarget();
    if (!role) throw AuthorizationErrors.roleNotFound();

    try {
      return await this.database.client.authorizationRoleAssignment.create({
        data: {
          identityId,
          roleKey,
          grantedByIdentityId: actorIdentityId,
          ...(reason ? { reason } : {}),
        },
        select: { id: true, identityId: true, roleKey: true, grantedAt: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw AuthorizationErrors.roleAlreadyAssigned();
      }
      throw error;
    }
  }

  async revokeRole(
    identityId: string,
    roleKey: string,
    actorIdentityId: string,
    reason?: string,
  ): Promise<void> {
    const result = await this.database.client.authorizationRoleAssignment.updateMany({
      where: { identityId, roleKey, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedByIdentityId: actorIdentityId,
        ...(reason ? { reason } : {}),
      },
    });
    if (result.count !== 1) throw AuthorizationErrors.roleNotAssigned();
  }
}
