/**
 * SEED-REALISTIC-1 demonstration dataset (operator CLI, no HTTP endpoint).
 *
 *   pnpm seed:realistic -- [--dry-run | --apply | --summary | --cleanup-seed-only]
 *     [--anchor-date YYYY-MM-DD] [--trips-per-direction N] [--confirm-production]
 *
 * Read only unless --apply or --cleanup-seed-only is given. Writes need
 * ALLOW_REALISTIC_SEED=true and, in production, --confirm-production. Every
 * write goes through the domain services as the `realistic-seed` system
 * actor; the DATA-1 pilot corridor runs first, as `pilot-bootstrap`.
 * Exit codes: 0 done, 2 refused or conflicts, 1 error. The database target
 * is printed masked; no secret is ever printed.
 */
import { ConfigValidationError, loadApiEnv } from '@euroteranga/config';
import { createLogger, redactString } from '@euroteranga/logger';
import { AuditService } from '../authorization/audit.service.js';
import { ContentService } from '../content/content.service.js';
import { DatabaseService } from '../database/database.service.js';
import { FleetService } from '../fleet/fleet.service.js';
import { NetworkService } from '../network/network.service.js';
import { PILOT_DATASET_VERSION } from '../pilot/pilot-dataset.js';
import { PricingService } from '../pricing/pricing.service.js';
import { SeatMapService } from '../seat-maps/seat-map.service.js';
import {
  maskedDatabaseTarget,
  parseRealisticArgs,
  realisticRefusal,
  writes,
} from '../seed/realistic/realistic-args.js';
import { REALISTIC_NAMESPACE } from '../seed/realistic/realistic-dataset.js';
import { summarize } from '../seed/realistic/realistic-report.js';
import { RealisticSeed } from '../seed/realistic/realistic-seed.js';
import { TripService } from '../trips/trip.service.js';

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<number> {
  const parsed = parseRealisticArgs(process.argv.slice(2), new Date());
  if (!parsed.ok) {
    err(parsed.message);
    err(
      'Usage: seed:realistic [--dry-run | --apply | --summary | --cleanup-seed-only] [--anchor-date YYYY-MM-DD] [--trips-per-direction N] [--confirm-production]',
    );
    return 2;
  }
  const { args } = parsed;
  const env = loadApiEnv();
  const refusal = realisticRefusal(
    {
      APP_ENV: env.APP_ENV,
      ALLOW_REALISTIC_SEED: process.env.ALLOW_REALISTIC_SEED,
      REALISTIC_SEED_NAMESPACE: process.env.REALISTIC_SEED_NAMESPACE,
    },
    args,
  );
  out(
    `Realistic dataset ${REALISTIC_NAMESPACE} on pilot ${PILOT_DATASET_VERSION} — APP_ENV=${env.APP_ENV}, ` +
      `database ${maskedDatabaseTarget(process.env.DATABASE_URL)}, mode ${args.mode}` +
      `${writes(args.mode) ? '' : ' (nothing is written)'}.`,
  );
  if (refusal) {
    err(`Refused: ${refusal}`);
    return 2;
  }
  if (args.mode === 'cleanup-seed-only') {
    err('--cleanup-seed-only is not available yet in this version.');
    return 2;
  }

  const logger = createLogger({ service: 'realistic-seed-cli', level: 'warn' });
  const database = new DatabaseService(env, logger);
  try {
    const audit = new AuditService(database);
    const seed = new RealisticSeed({
      db: database.client,
      network: new NetworkService(database, audit),
      seatMaps: new SeatMapService(database, audit),
      fleet: new FleetService(database, audit),
      pricing: new PricingService(database, audit),
      trips: new TripService(database, audit),
      content: new ContentService(database, audit),
    });
    const report = await seed.run({
      anchorDate: args.anchorDate,
      tripsPerDirection: args.tripsPerDirection,
      dryRun: args.mode !== 'apply',
    });
    if (args.mode !== 'summary') {
      for (const line of report.lines) {
        out(
          `${line.outcome.padEnd(9)} ${line.entity.padEnd(11)} ${line.key}${line.detail ? ` — ${line.detail}` : ''}`,
        );
      }
    }
    for (const row of summarize(report.lines)) out(row);
    if (report.hasConflicts) {
      err('Some items conflict with existing data and were left untouched (see "conflict" lines).');
      return 2;
    }
    return 0;
  } finally {
    await database.client.$disconnect();
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
      `Realistic seed failed: ${redactString(error instanceof Error ? error.message : String(error))}`,
    );
    process.exit(1);
  });
