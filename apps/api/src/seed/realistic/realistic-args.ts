import { parseArgs } from 'node:util';
import { MAX_TRIPS_PER_DIRECTION } from '../../pilot/pilot-bootstrap.js';
import { REALISTIC_NAMESPACE, REALISTIC_TRIPS_PER_DIRECTION } from './realistic-dataset.js';

export const REALISTIC_MODES = ['dry-run', 'apply', 'summary', 'cleanup-seed-only'] as const;
export type RealisticMode = (typeof REALISTIC_MODES)[number];

export interface RealisticArgs {
  mode: RealisticMode;
  confirmProduction: boolean;
  anchorDate: string;
  tripsPerDirection: number;
}

export type RealisticArgsResult =
  { ok: true; args: RealisticArgs } | { ok: false; message: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses `[--dry-run | --apply | --summary | --cleanup-seed-only]
 * [--confirm-production] [--anchor-date YYYY-MM-DD] [--trips-per-direction N]`.
 * Without a mode, nothing is written (`--dry-run`). A single leading `--`
 * (forwarded by pnpm) is ignored; anything else unexpected is refused.
 */
export function parseRealisticArgs(argv: readonly string[], today: Date): RealisticArgsResult {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        'dry-run': { type: 'boolean' },
        apply: { type: 'boolean' },
        summary: { type: 'boolean' },
        'cleanup-seed-only': { type: 'boolean' },
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
  const modes = REALISTIC_MODES.filter((mode) => values[mode] === true);
  if (modes.length > 1) {
    return { ok: false, message: `Choose one mode: ${modes.map((m) => `--${m}`).join(', ')}.` };
  }
  const todayDate = today.toISOString().slice(0, 10);
  const anchorDate = typeof values['anchor-date'] === 'string' ? values['anchor-date'] : todayDate;
  // Date.parse shifts impossible days (2030-04-31 → May 1): require a round trip.
  const parsedAnchor = Date.parse(`${anchorDate}T00:00:00Z`);
  if (
    !DATE.test(anchorDate) ||
    Number.isNaN(parsedAnchor) ||
    new Date(parsedAnchor).toISOString().slice(0, 10) !== anchorDate
  ) {
    return { ok: false, message: '--anchor-date must be a calendar date (YYYY-MM-DD).' };
  }
  if (anchorDate < todayDate) {
    return { ok: false, message: '--anchor-date cannot be in the past.' };
  }
  const rawTrips =
    typeof values['trips-per-direction'] === 'string'
      ? values['trips-per-direction']
      : String(REALISTIC_TRIPS_PER_DIRECTION);
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
      mode: modes[0] ?? 'dry-run',
      confirmProduction: values['confirm-production'] === true,
      anchorDate,
      tripsPerDirection,
    },
  };
}

export const writes = (mode: RealisticMode) => mode === 'apply' || mode === 'cleanup-seed-only';

/**
 * Writes need ALLOW_REALISTIC_SEED=true (set on purpose, never by default),
 * the expected namespace when one is configured, and --confirm-production in
 * production. Read-only modes are always allowed.
 */
export function realisticRefusal(
  env: {
    APP_ENV: string;
    ALLOW_REALISTIC_SEED?: string | undefined;
    REALISTIC_SEED_NAMESPACE?: string | undefined;
  },
  args: RealisticArgs,
): string | null {
  if (env.REALISTIC_SEED_NAMESPACE && env.REALISTIC_SEED_NAMESPACE !== REALISTIC_NAMESPACE) {
    return `REALISTIC_SEED_NAMESPACE=${env.REALISTIC_SEED_NAMESPACE} does not match this seed (${REALISTIC_NAMESPACE}).`;
  }
  if (!writes(args.mode)) return null;
  if (env.ALLOW_REALISTIC_SEED !== 'true') {
    return 'writing the realistic dataset needs ALLOW_REALISTIC_SEED=true (try --dry-run first).';
  }
  if (env.APP_ENV === 'production' && !args.confirmProduction) {
    return 'APP_ENV=production: the realistic dataset is written only with --confirm-production, after an approved dry run.';
  }
  return null;
}

/** "postgresql://***@lo…st:5432/eu…e2e": enough to recognise the target, nothing secret. */
export function maskedDatabaseTarget(url: string | undefined): string {
  if (!url) return '(not set)';
  try {
    const parsed = new URL(url);
    const mask = (value: string) =>
      value.length <= 4 ? '***' : `${value.slice(0, 2)}…${value.slice(-3)}`;
    const host = parsed.hostname ? mask(parsed.hostname) : 'socket';
    const port = parsed.port ? `:${parsed.port}` : '';
    const database = mask(parsed.pathname.replace(/^\//, ''));
    return `${parsed.protocol}//***@${host}${port}/${database}`;
  } catch {
    return '(unparsable)';
  }
}
