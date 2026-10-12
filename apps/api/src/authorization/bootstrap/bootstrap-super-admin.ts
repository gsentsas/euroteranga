import { AuthIdentityStatus, AuthRealm, type PrismaClient } from '@euroteranga/database';
import { secureRandomToken } from '../../auth/crypto/tokens.js';
import { displayEmail, normalizeEmail } from '../../auth/identity/email.js';
import { countUsablePrivilegedAdmins, lockPrivilegedInvariants } from '../access-rules.js';
import { SYSTEM_ROLES } from '../permissions.js';
import {
  ensureRole,
  issueEnrollmentGrant,
  issueInvitation,
} from '../provisioning/staff-provisioning.service.js';

export type BootstrapOutcome =
  | {
      kind: 'invitation';
      identityId: string;
      email: string;
      /** Raw invitation token: to be delivered once, never logged or stored. */
      token: string;
      expiresAt: Date;
      regenerated: boolean;
    }
  | { kind: 'enrollment-grant'; identityId: string; expiresAt: Date }
  | { kind: 'role-granted'; identityId: string };

export type BootstrapRefusal =
  'SUPER_ADMIN_ALREADY_ACTIVE' | 'PENDING_BOOTSTRAP_FOR_ANOTHER_EMAIL' | 'IDENTITY_NOT_USABLE';

export class BootstrapRefusedError extends Error {
  constructor(
    readonly reason: BootstrapRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'BootstrapRefusedError';
  }
}

export interface BootstrapInput {
  email: string;
  invitationTtlMs: number;
  enrollmentGrantTtlMs: number;
}

/**
 * Initial SUPER_ADMIN bootstrap, run by an operator through the CLI (there is
 * no HTTP endpoint). It never creates a session or a password:
 *
 * - a usable SUPER_ADMIN (ACTIVE, MFA enabled) already exists → refused;
 * - an unfinished bootstrap exists for another email → refused (see runbook);
 * - unknown email → new PENDING STAFF identity + SUPER_ADMIN + invitation;
 * - pending bootstrap for the same email → invitation regenerated (recovery
 *   from an expired or lost invitation; the previous link stops working);
 * - ACTIVE STAFF without MFA → SUPER_ADMIN + first-enrollment grant;
 * - ACTIVE STAFF with MFA → SUPER_ADMIN granted.
 *
 * Everything happens in one transaction, serialized with other privileged
 * changes, and is recorded as a system audit event (no actor).
 */
export async function bootstrapSuperAdmin(
  db: PrismaClient,
  input: BootstrapInput,
): Promise<BootstrapOutcome> {
  const normalizedEmail = normalizeEmail(input.email);

  return db.$transaction(async (tx) => {
    await lockPrivilegedInvariants(tx);

    if ((await countUsablePrivilegedAdmins(tx)) > 0) {
      throw new BootstrapRefusedError(
        'SUPER_ADMIN_ALREADY_ACTIVE',
        'An active SUPER_ADMIN with MFA already exists: use the OPS administration instead.',
      );
    }

    const pending = await tx.authIdentity.findMany({
      where: {
        roleAssignments: { some: { revokedAt: null, role: { key: SYSTEM_ROLES.SUPER_ADMIN } } },
        normalizedEmail: { not: normalizedEmail },
      },
      select: { id: true },
    });
    if (pending.length > 0) {
      throw new BootstrapRefusedError(
        'PENDING_BOOTSTRAP_FOR_ANOTHER_EMAIL',
        'An unfinished bootstrap exists for another address: rerun with that address, or follow docs/runbooks/bootstrap-super-admin.md.',
      );
    }

    const existing = await tx.authIdentity.findUnique({
      where: { realm_normalizedEmail: { realm: AuthRealm.STAFF, normalizedEmail } },
      select: {
        id: true,
        email: true,
        status: true,
        passwordCredential: { select: { identityId: true } },
        mfaTotpCredential: { select: { enabledAt: true } },
      },
    });

    let outcome: BootstrapOutcome;
    if (
      !existing ||
      (existing.status === AuthIdentityStatus.PENDING_VERIFICATION && !existing.passwordCredential)
    ) {
      const identity =
        existing ??
        (await tx.authIdentity.create({
          data: {
            realm: AuthRealm.STAFF,
            email: displayEmail(input.email),
            normalizedEmail,
            status: AuthIdentityStatus.PENDING_VERIFICATION,
          },
          select: { id: true, email: true },
        }));
      const roleAdded = await ensureRole(tx, identity.id, SYSTEM_ROLES.SUPER_ADMIN, null);
      const token = secureRandomToken();
      const expiresAt = new Date(Date.now() + input.invitationTtlMs);
      await issueInvitation(tx, identity.id, token, expiresAt, null);
      outcome = {
        kind: 'invitation',
        identityId: identity.id,
        email: identity.email,
        token,
        expiresAt,
        regenerated: Boolean(existing) && !roleAdded,
      };
    } else if (existing.status === AuthIdentityStatus.ACTIVE && existing.passwordCredential) {
      await ensureRole(tx, existing.id, SYSTEM_ROLES.SUPER_ADMIN, null);
      if (existing.mfaTotpCredential?.enabledAt) {
        outcome = { kind: 'role-granted', identityId: existing.id };
      } else {
        const expiresAt = new Date(Date.now() + input.enrollmentGrantTtlMs);
        await issueEnrollmentGrant(tx, existing.id, expiresAt, null);
        outcome = { kind: 'enrollment-grant', identityId: existing.id, expiresAt };
      }
    } else {
      throw new BootstrapRefusedError(
        'IDENTITY_NOT_USABLE',
        'This STAFF identity is suspended, disabled or in an inconsistent state.',
      );
    }

    await tx.auditEvent.create({
      data: {
        action: 'SUPER_ADMIN_BOOTSTRAPPED',
        resourceType: 'auth_identity',
        resourceId: outcome.identityId,
        after: { roleKey: SYSTEM_ROLES.SUPER_ADMIN },
        metadata: {
          source: 'bootstrap-cli',
          outcome: outcome.kind,
          ...(outcome.kind === 'invitation' ? { regenerated: outcome.regenerated } : {}),
        },
      },
    });
    return outcome;
  });
}
