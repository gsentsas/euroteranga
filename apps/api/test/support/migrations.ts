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
