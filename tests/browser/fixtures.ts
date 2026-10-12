/**
 * Synthetic identities for browser tests only. They are written directly to
 * the disposable test database by global-setup.ts; no endpoint creates them.
 */
export const FIXTURE_PASSWORD = 'synthetic browser test passphrase 0042';

export const FIXTURES = {
  customer: { realm: 'CUSTOMER', email: 'customer.e2e@fixtures.example.test' },
  staff: { realm: 'STAFF', email: 'staff.e2e@fixtures.example.test' },
  crew: { realm: 'CREW', email: 'crew.e2e@fixtures.example.test' },
} as const;
