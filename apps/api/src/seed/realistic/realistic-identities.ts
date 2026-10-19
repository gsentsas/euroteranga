import type { PrismaClient } from '@euroteranga/database';
import type { AuditService } from '../../authorization/audit.service.js';
import { REALISTIC_SOURCE } from './realistic-dataset.js';
import {
  RealisticConflict,
  type RealisticLayer,
  type RealisticReporter,
} from './realistic-report.js';

export type SyntheticRealm = 'CUSTOMER' | 'STAFF' | 'CREW';

/**
 * A synthetic identity of the seed, created once and found again by its
 * reserved address. ACTIVE because the database requires it of a customer
 * holding seats, an incident opener or an assigned crew member; never a
 * password, a role or an MFA factor, so no one can sign in with it or act
 * through the API. Each creation is audited by the system actor.
 */
export async function ensureSyntheticIdentity(
  db: PrismaClient,
  audit: AuditService,
  reporter: RealisticReporter,
  input: {
    layer: RealisticLayer;
    entity: string;
    key: string;
    realm: SyntheticRealm;
    email: string;
  },
): Promise<string> {
  const existing = await db.authIdentity.findUnique({
    where: { realm_normalizedEmail: { realm: input.realm, normalizedEmail: input.email } },
    select: {
      id: true,
      status: true,
      passwordCredential: { select: { identityId: true } },
      mfaTotpCredential: { select: { identityId: true } },
      _count: {
        select: {
          roleAssignments: { where: { revokedAt: null } },
          mfaRecoveryCodes: true,
        },
      },
    },
  });
  if (existing) {
    // Reused only if the seed created it and it still cannot sign in or act:
    // a person may have been given this address in the meantime.
    const seeded = await db.auditEvent.count({
      where: {
        resourceType: 'auth_identity',
        resourceId: existing.id,
        action: `${input.realm}_IDENTITY_SEEDED`,
        metadata: { path: ['systemActor'], equals: REALISTIC_SOURCE },
      },
    });
    if (seeded === 0) {
      throw new RealisticConflict(`${input.email} was not created by the seed (kept, not used)`);
    }
    if (
      existing.passwordCredential ||
      existing.mfaTotpCredential ||
      existing._count.roleAssignments > 0 ||
      existing._count.mfaRecoveryCodes > 0
    ) {
      throw new RealisticConflict(
        `${input.email} now has a password, an MFA factor or a role (kept, not used)`,
      );
    }
    if (existing.status !== 'ACTIVE') {
      throw new RealisticConflict(`synthetic identity ${input.email} is ${existing.status}`);
    }
    reporter.report({
      layer: input.layer,
      outcome: 'existing',
      entity: input.entity,
      key: input.key,
    });
    return existing.id;
  }
  const id = await db.$transaction(async (tx) => {
    const identity = await tx.authIdentity.create({
      data: {
        realm: input.realm,
        email: input.email,
        normalizedEmail: input.email,
        status: 'ACTIVE',
        // Required of an ACTIVE customer; the reserved address receives no mail.
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await audit.record(
      {
        actor: { kind: 'system', source: REALISTIC_SOURCE },
        action: `${input.realm}_IDENTITY_SEEDED`,
        resourceType: 'auth_identity',
        resourceId: identity.id,
        after: { realm: input.realm, status: 'ACTIVE' },
        metadata: { synthetic: true, credential: 'none', roles: 'none' },
      },
      tx,
    );
    return identity.id;
  });
  reporter.report({ layer: input.layer, outcome: 'created', entity: input.entity, key: input.key });
  return id;
}
