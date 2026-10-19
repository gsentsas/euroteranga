import { describe, expect, it } from 'vitest';
import {
  maskedDatabaseTarget,
  parseRealisticArgs,
  realisticRefusal,
  type RealisticArgs,
} from '../../../src/seed/realistic/realistic-args.js';
import { summarize } from '../../../src/seed/realistic/realistic-report.js';

const now = new Date('2030-03-10T12:00:00Z');
const args = (overrides: Partial<RealisticArgs> = {}): RealisticArgs => ({
  mode: 'dry-run',
  confirmProduction: false,
  anchorDate: '2030-03-10',
  tripsPerDirection: 6,
  ...overrides,
});

describe('realistic seed arguments', () => {
  it('reads nothing but a dry run by default, with six departures per direction', () => {
    expect(parseRealisticArgs([], now)).toEqual({ ok: true, args: args() });
    expect(parseRealisticArgs(['--', '--apply'], now)).toEqual({
      ok: true,
      args: args({ mode: 'apply' }),
    });
  });

  it('refuses two modes, unknown options, past or impossible dates and bad counts', () => {
    for (const argv of [
      ['--apply', '--dry-run'],
      ['--apply', '--cleanup-seed-only'],
      ['--force'],
      ['--anchor-date', '2030-03-09'],
      ['--anchor-date', '2030-04-31'],
      ['--trips-per-direction', '0'],
      ['--trips-per-direction', '9'],
      ['--trips-per-direction', '2.5'],
    ]) {
      expect(parseRealisticArgs(argv, now).ok, argv.join(' ')).toBe(false);
    }
  });

  it('writes only with ALLOW_REALISTIC_SEED=true, the right namespace and production confirmed', () => {
    const local = { APP_ENV: 'local', ALLOW_REALISTIC_SEED: 'true' };
    expect(realisticRefusal({ APP_ENV: 'local' }, args())).toBeNull();
    expect(realisticRefusal({ APP_ENV: 'local' }, args({ mode: 'summary' }))).toBeNull();
    expect(realisticRefusal({ APP_ENV: 'local' }, args({ mode: 'apply' }))).toMatch(
      /ALLOW_REALISTIC_SEED=true/,
    );
    expect(
      realisticRefusal({ APP_ENV: 'local', ALLOW_REALISTIC_SEED: '1' }, args({ mode: 'apply' })),
    ).toMatch(/ALLOW_REALISTIC_SEED=true/);
    expect(realisticRefusal(local, args({ mode: 'apply' }))).toBeNull();
    expect(realisticRefusal(local, args({ mode: 'cleanup-seed-only' }))).toBeNull();
    expect(
      realisticRefusal({ ...local, REALISTIC_SEED_NAMESPACE: 'OTHER' }, args({ mode: 'apply' })),
    ).toMatch(/does not match/);
    // Production: a dry run is always allowed, a write needs an explicit confirmation.
    const production = { APP_ENV: 'production', ALLOW_REALISTIC_SEED: 'true' };
    expect(realisticRefusal(production, args())).toBeNull();
    expect(realisticRefusal(production, args({ mode: 'apply' }))).toMatch(/--confirm-production/);
    expect(
      realisticRefusal(production, args({ mode: 'apply', confirmProduction: true })),
    ).toBeNull();
    expect(
      realisticRefusal({ APP_ENV: 'production' }, args({ mode: 'apply', confirmProduction: true })),
    ).toMatch(/ALLOW_REALISTIC_SEED=true/);
  });

  it('masks the database target and never prints credentials', () => {
    const masked = maskedDatabaseTarget(
      'postgresql://app_user:s3cr3t-value@db.internal.example:5432/euroteranga_prod?sslmode=require',
    );
    expect(masked).toBe('postgresql://***@db…ple:5432/eu…rod');
    expect(masked).not.toMatch(/s3cr3t|app_user|sslmode/);
    expect(maskedDatabaseTarget(undefined)).toBe('(not set)');
    expect(maskedDatabaseTarget('not a url')).toBe('(unparsable)');
  });

  it('summarizes outcomes per entity in seed order', () => {
    expect(
      summarize([
        { layer: 'catalogue', outcome: 'created', entity: 'vehicle', key: 'A' },
        { layer: 'catalogue', outcome: 'existing', entity: 'country', key: 'FR' },
        { layer: 'catalogue', outcome: 'conflict', entity: 'vehicle', key: 'B' },
      ]),
    ).toEqual([
      'Countries     created=0 updated=0 existing=1 planned=0 skipped=0 conflict=0',
      'Vehicles      created=1 updated=0 existing=0 planned=0 skipped=0 conflict=1',
    ]);
  });
});
