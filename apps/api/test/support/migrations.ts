import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(
  fileURLToPath(new URL('../../../../packages/database/', import.meta.url)),
  'prisma',
  'migrations',
);

/**
 * Every migration of the repository, in application order. Upgrade tests
 * compare the applied history with this list, so adding a migration does not
 * require editing a hard-coded count in each of them.
 */
export const CURRENT_MIGRATIONS: readonly string[] = readdirSync(MIGRATIONS, {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

export const LATEST_MIGRATION = CURRENT_MIGRATIONS.at(-1) as string;

/**
 * PAY-HUB-1. Since this migration the API starts no payment without a quote,
 * so upgrade tests that build their historical data through today's API
 * include it in that history: it only adds objects and needs nothing after
 * PR-10's payments. The migration each test measures is unchanged. The real
 * upgrade of PR-10 payments to PAY-HUB-1 is measured on its own
 * (upgrade-from-pr10-payments.int.spec.ts).
 */
export const PAYMENT_HUB_MIGRATION = '20261020090000_pay_hub_core';

/** Whether a migration belongs to a history that goes up to `last`. */
export const historical = (entry: string, last: string): boolean =>
  entry <= last || entry === PAYMENT_HUB_MIGRATION;

/** An applied list without PAY-HUB-1, to measure the migrations in their own order. */
export const withoutPaymentHub = (applied: readonly string[]): string[] =>
  applied.filter((entry) => entry !== PAYMENT_HUB_MIGRATION);
