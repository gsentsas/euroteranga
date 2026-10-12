/**
 * Synthetic identities for browser tests only. They are written directly to
 * the disposable test database by global-setup.ts; no endpoint creates them.
 */
export const FIXTURE_PASSWORD = 'synthetic browser test passphrase 0042';

type Realm = 'CUSTOMER' | 'STAFF' | 'CREW';

export interface Fixture {
  realm: Realm;
  email: string;
  /** STAFF only: roles granted at seed time (none means no `ops.access`). */
  roles?: readonly string[];
  /** STAFF only: the account is pending until the invitation is accepted. */
  invited?: boolean;
}

/**
 * STAFF fixtures get a fresh address on every run: role assignments and
 * audit events reference them and are never deleted (append-only audit),
 * so they cannot be reset in place. global-setup.ts sets E2E_RUN_ID, which
 * Playwright passes on to the test workers.
 */
function runScoped(name: string): string {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) throw new Error('E2E_RUN_ID is set by global-setup.ts');
  return `${name}.${runId}.e2e@fixtures.example.test`;
}

export const FIXTURES = {
  customer: { realm: 'CUSTOMER', email: 'customer.e2e@fixtures.example.test' },
  crew: { realm: 'CREW', email: 'crew.e2e@fixtures.example.test' },
  get staff(): Fixture {
    return { realm: 'STAFF', email: runScoped('staff'), roles: ['DISPATCHER'] };
  },
  get staffWithoutAccess(): Fixture {
    return { realm: 'STAFF', email: runScoped('no-access'), roles: [] };
  },
  get superAdmin(): Fixture {
    return { realm: 'STAFF', email: runScoped('super-admin'), roles: ['SUPER_ADMIN'] };
  },
  /** Dedicated identities keep fully-parallel network scenarios independent. */
  get networkAdmin(): Fixture {
    return { realm: 'STAFF', email: runScoped('network-admin'), roles: ['SUPER_ADMIN'] };
  },
  get networkReader(): Fixture {
    return { realm: 'STAFF', email: runScoped('network-reader'), roles: ['DISPATCHER'] };
  },
  get networkDenied(): Fixture {
    return { realm: 'STAFF', email: runScoped('network-denied'), roles: ['FINANCE'] };
  },
  get auditor(): Fixture {
    return { realm: 'STAFF', email: runScoped('auditor'), roles: ['AUDITOR'] };
  },
  /** Target of the SUPER_ADMIN's role and status changes. */
  get managed(): Fixture {
    return { realm: 'STAFF', email: runScoped('managed'), roles: ['DISPATCHER'] };
  },
  get invited(): Fixture {
    return { realm: 'STAFF', email: runScoped('invited'), roles: ['DISPATCHER'], invited: true };
  },
} satisfies Record<string, Fixture>;

/** Single-use invitation token of the `invited` fixture (random per run). */
export function invitationToken(): string {
  const token = process.env.E2E_INVITATION_TOKEN;
  if (!token) throw new Error('E2E_INVITATION_TOKEN is set by global-setup.ts');
  return token;
}
