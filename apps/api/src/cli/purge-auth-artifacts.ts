/**
 * Operator CLI for PR-24 authentication retention.
 *
 * Run after the API package is built:
 *   pnpm auth:purge-expired
 *
 * Safe to schedule repeatedly. Output contains only deletion counts and the
 * retention snapshot time; no token, email, IP, cookie or credential value.
 */
import { ConfigValidationError, loadApiEnv } from '@euroteranga/config';
import { createDatabaseClient } from '@euroteranga/database';
import { redactString } from '@euroteranga/logger';
import { purgeExpiredAuthArtifacts } from '../auth/retention/purge-auth-artifacts.js';

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<number> {
  const env = loadApiEnv();
  const database = createDatabaseClient({ databaseUrl: env.DATABASE_URL });
  const now = new Date();
  try {
    const purged = await purgeExpiredAuthArtifacts(database, now);
    out(JSON.stringify({ purgedAt: now.toISOString(), purged }));
    return 0;
  } finally {
    await database.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof ConfigValidationError) {
      err(error.message);
      process.exit(1);
    }
    err(
      `Authentication retention purge failed: ${redactString(error instanceof Error ? error.message : String(error))}`,
    );
    process.exit(1);
  });
