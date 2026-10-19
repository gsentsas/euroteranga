/**
 * DATA-1 pilot data bootstrap (operator CLI, no HTTP endpoint).
 *
 *   pnpm data:bootstrap-pilot -- [--dry-run] [--anchor-date YYYY-MM-DD]
 *     [--trips-per-direction N] [--confirm-production]
 *
 * Idempotent and resumable: existing matching data is reused, never
 * overwritten. Writes go through the domain services and are audited with
 * the `pilot-bootstrap` system actor. Production is refused unless
 * --confirm-production is given. Exit codes: 0 done, 2 refused or conflicts,
 * 1 error. Nothing secret is printed (no connection string, no identifier
 * other than business codes).
 */
import { ConfigValidationError, loadApiEnv } from '@euroteranga/config';
import { createLogger, redactString } from '@euroteranga/logger';
import { AuditService } from '../authorization/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { FleetService } from '../fleet/fleet.service.js';
import { NetworkService } from '../network/network.service.js';
import { parsePilotArgs, productionRefusal } from '../pilot/pilot-args.js';
import { PilotBootstrap } from '../pilot/pilot-bootstrap.js';
import { PILOT_DATASET_VERSION } from '../pilot/pilot-dataset.js';
import { PricingService } from '../pricing/pricing.service.js';
import { SeatMapService } from '../seat-maps/seat-map.service.js';
import { TripService } from '../trips/trip.service.js';

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<number> {
  const parsed = parsePilotArgs(process.argv.slice(2), new Date());
  if (!parsed.ok) {
    err(parsed.message);
    err(
      'Usage: data:bootstrap-pilot [--dry-run] [--anchor-date YYYY-MM-DD] [--trips-per-direction N] [--confirm-production]',
    );
    return 2;
  }
  const env = loadApiEnv();
  const refusal = productionRefusal(env.APP_ENV, parsed.args);
  if (refusal) {
    err(`Refused: ${refusal}`);
    return 2;
  }

  const logger = createLogger({ service: 'pilot-bootstrap-cli', level: 'warn' });
  const database = new DatabaseService(env, logger);
  try {
    const audit = new AuditService(database);
    const bootstrap = new PilotBootstrap({
      db: database.client,
      network: new NetworkService(database, audit),
      seatMaps: new SeatMapService(database, audit),
      fleet: new FleetService(database, audit),
      pricing: new PricingService(database, audit),
      trips: new TripService(database, audit),
    });
    out(
      `Pilot dataset ${PILOT_DATASET_VERSION} — APP_ENV=${env.APP_ENV}, anchor ${parsed.args.anchorDate}, ` +
        `${parsed.args.tripsPerDirection} departures per direction${parsed.args.dryRun ? ' (dry run: nothing is written)' : ''}.`,
    );
    const report = await bootstrap.run(parsed.args);
    for (const line of report.lines) {
      out(
        `${line.outcome.padEnd(9)} ${line.entity.padEnd(10)} ${line.key}${line.detail ? ` — ${line.detail}` : ''}`,
      );
    }
    const totals = new Map<string, number>();
    for (const line of report.lines) totals.set(line.outcome, (totals.get(line.outcome) ?? 0) + 1);
    out(`Summary: ${[...totals].map(([outcome, count]) => `${outcome}=${count}`).join(' ')}`);
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
      `Pilot bootstrap failed: ${redactString(error instanceof Error ? error.message : String(error))}`,
    );
    process.exit(1);
  });
