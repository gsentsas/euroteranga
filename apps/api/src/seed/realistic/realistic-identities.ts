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
    select: { id: true, status: true },
  });
  if (existing) {
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
