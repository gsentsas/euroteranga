import { parseArgs } from 'node:util';
import { MAX_TRIPS_PER_DIRECTION } from './pilot-bootstrap.js';

export interface PilotArgs {
  dryRun: boolean;
  confirmProduction: boolean;
  anchorDate: string;
  tripsPerDirection: number;
}

export type PilotArgsResult = { ok: true; args: PilotArgs } | { ok: false; message: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses `[--dry-run] [--confirm-production] [--anchor-date YYYY-MM-DD]
 * [--trips-per-direction N]`. A single leading `--` (forwarded by pnpm) is
 * ignored; anything else unexpected is refused.
 */
export function parsePilotArgs(argv: readonly string[], today: Date): PilotArgsResult {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: {
    'dry-run'?: boolean | undefined;
    'confirm-production'?: boolean | undefined;
    'anchor-date'?: string | undefined;
    'trips-per-direction'?: string | undefined;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        'dry-run': { type: 'boolean' },
        'confirm-production': { type: 'boolean' },
        'anchor-date': { type: 'string' },
        'trips-per-direction': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'invalid arguments' };
  }
  const todayDate = today.toISOString().slice(0, 10);
  const anchorDate = values['anchor-date'] ?? todayDate;
  if (!DATE.test(anchorDate) || Number.isNaN(Date.parse(`${anchorDate}T00:00:00Z`))) {
    return { ok: false, message: '--anchor-date must be a calendar date (YYYY-MM-DD).' };
  }
  if (anchorDate < todayDate) {
    return { ok: false, message: '--anchor-date cannot be in the past.' };
  }
  const rawTrips = values['trips-per-direction'] ?? '4';
  const tripsPerDirection = /^\d+$/.test(rawTrips) ? Number(rawTrips) : Number.NaN;
  if (
    !Number.isInteger(tripsPerDirection) ||
    tripsPerDirection < 1 ||
    tripsPerDirection > MAX_TRIPS_PER_DIRECTION
  ) {
    return {
      ok: false,
      message: `--trips-per-direction must be an integer from 1 to ${MAX_TRIPS_PER_DIRECTION}.`,
    };
  }
  return {
    ok: true,
    args: {
      dryRun: values['dry-run'] ?? false,
      confirmProduction: values['confirm-production'] ?? false,
      anchorDate,
      tripsPerDirection,
    },
  };
}

/** Production is refused unless explicitly confirmed; other environments need no flag. */
export function productionRefusal(appEnv: string, args: PilotArgs): string | null {
  if (appEnv === 'production' && !args.confirmProduction && !args.dryRun) {
    return 'APP_ENV=production: the pilot dataset is written only with --confirm-production (try --dry-run first).';
  }
  return null;
}
