import { AuthIdentityStatus, type DatabaseTransaction } from '@euroteranga/database';
import { AuthorizationErrors } from './authorization.errors.js';
import { PERMISSIONS } from './permissions.js';

/**
 * Serialises every operation that can change who holds a privileged role or
 * whether such a holder is usable, so the "at least one usable privileged
 * administrator" invariant cannot be broken by two concurrent requests.
 */
const PRIVILEGED_LOCK_KEY = 0x45545f52424143n; // "ET_RBAC"

export async function lockPrivilegedInvariants(tx: DatabaseTransaction): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PRIVILEGED_LOCK_KEY})`;
}

/** Effective permissions of an identity, read from the database now. */
export async function permissionsOf(
  tx: DatabaseTransaction,
  identityId: string,
): Promise<Set<string>> {
  const rows = await tx.authorizationRolePermission.findMany({
    where: { role: { assignments: { some: { identityId, revokedAt: null } } } },
    select: { permissionKey: true },
  });
  return new Set(rows.map((row) => row.permissionKey));
}

export async function holdsPrivilegedRole(
  tx: DatabaseTransaction,
  identityId: string,
): Promise<boolean> {
  const count = await tx.authorizationRoleAssignment.count({
    where: { identityId, revokedAt: null, role: { privileged: true } },
  });
  return count > 0;
}

/**
 * An actor may only act on an identity holding a privileged role (status,
 * sessions, MFA, roles) if it holds privileged.manage itself.
 */
export async function assertMayActOn(
  tx: DatabaseTransaction,
  actorPermissions: ReadonlySet<string>,
  targetIdentityId: string,
): Promise<void> {
  if (
    !actorPermissions.has(PERMISSIONS.PRIVILEGED_MANAGE) &&
    (await holdsPrivilegedRole(tx, targetIdentityId))
  ) {
    throw AuthorizationErrors.forbidden();
  }
}

/**
 * Number of *usable* privileged administrators (active privileged role,
 * ACTIVE identity, MFA enabled), optionally ignoring one identity.
 */
export async function countUsablePrivilegedAdmins(
  tx: DatabaseTransaction,
  excludingIdentityId?: string,
): Promise<number> {
  return tx.authIdentity.count({
    where: {
      ...(excludingIdentityId ? { id: { not: excludingIdentityId } } : {}),
      status: AuthIdentityStatus.ACTIVE,
      mfaTotpCredential: { enabledAt: { not: null } },
      roleAssignments: { some: { revokedAt: null, role: { privileged: true } } },
    },
  });
}

/**
 * Refuses an operation that would leave no usable privileged administrator
 * when the target currently is one.
 */
export async function assertNotLastPrivilegedAdmin(
  tx: DatabaseTransaction,
  targetIdentityId: string,
): Promise<void> {
  if (!(await holdsPrivilegedRole(tx, targetIdentityId))) return;
  if ((await countUsablePrivilegedAdmins(tx, targetIdentityId)) === 0) {
    throw AuthorizationErrors.lastPrivilegedAdmin();
  }
}

/** Identity status changes allowed through the admin API. */
const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly AuthIdentityStatus[]>> = {
  [AuthIdentityStatus.ACTIVE]: [AuthIdentityStatus.SUSPENDED, AuthIdentityStatus.DISABLED],
  [AuthIdentityStatus.SUSPENDED]: [AuthIdentityStatus.ACTIVE, AuthIdentityStatus.DISABLED],
};

export function isAllowedStatusTransition(
  from: AuthIdentityStatus,
  to: AuthIdentityStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
