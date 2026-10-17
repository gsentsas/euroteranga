import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@euroteranga/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffActor } from '../../support/admin-helpers.js';
import { customerActor } from '../../support/booking-helpers.js';
import {
  boardingApi,
  compliantPassenger,
  staffCheckInApi,
} from '../../support/check-in-helpers.js';
import { integrationEnv, startTestApp, type TestApp } from '../../support/test-app.js';

const DATABASE_PACKAGE = fileURLToPath(
  new URL('../../../../../packages/database/', import.meta.url),
);
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma', 'migrations');
const PR17_MIGRATION = '20261015180000_departure_readiness';
const INCIDENT_MIGRATION = '20261017083000_incidents';

function deploy(config: string | null, url: string) {
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])],
    {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'ignore',
    },
  );
}

describe('upgrade from a real PR-17 database', () => {
  let root: ReturnType<typeof createDatabaseClient>;
  let raw: ReturnType<typeof createDatabaseClient>;
  let t: TestApp;
  let workDir: string;
  let url: string;
  let boardingId: string;
  let historicalSnapshot: string;
  const name = `et_pr17_${randomBytes(6).toString('hex')}`;

  const applied = async () =>
    (
      await raw.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).map((row) => row.migration_name);

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required');
    root = createDatabaseClient({ databaseUrl: base });
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const target = new URL(base);
    target.pathname = `/${name}`;
    url = target.toString();

    workDir = mkdtempSync(join(tmpdir(), 'et-pr17-upgrade-'));
    const historicalMigrations = join(workDir, 'migrations');
    for (const entry of readdirSync(MIGRATIONS)) {
      if (entry <= PR17_MIGRATION) {
        cpSync(join(MIGRATIONS, entry), join(historicalMigrations, entry), { recursive: true });
      }
    }
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: join(DATABASE_PACKAGE, 'prisma', 'schema.prisma'),
        migrations: { path: historicalMigrations },
        datasource: { url },
      })};\n`,
    );
    deploy(config, url);
    raw = createDatabaseClient({ databaseUrl: url });
    expect(await applied()).toHaveLength(17);
    expect((await applied()).at(-1)).toBe(PR17_MIGRATION);

    const env = integrationEnv({ DATABASE_URL: url });
    t = await startTestApp(env);
    const [customer, director, agent, dispatcher] = await Promise.all([
      customerActor(t.app),
      staffActor(t.app, ['DIRECTOR']),
      staffActor(t.app, ['BOOKING_AGENT']),
      staffActor(t.app, ['DISPATCHER']),
    ]);
    const ready = await compliantPassenger(t.app, env, customer, director);
    const checked = await staffCheckInApi(agent).checkIn(
      ready.bookingReference,
      ready.passengerReference,
    );
    if (checked.status !== 201) throw new Error(`historical check-in failed: ${checked.text}`);
    const boarded = await boardingApi(dispatcher).scan({
      qrPayload: checked.body.checkIn.qrPayload,
      deviceId: 'historical-staff-gate',
      clientEventId: `historical-${randomBytes(4).toString('hex')}`,
      occurredAt: new Date().toISOString(),
    });
    if (boarded.status !== 201) throw new Error(`historical boarding failed: ${boarded.text}`);
    boardingId = (
      await raw.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM passenger_boarding WHERE reference = '${boarded.body.boarding.reference}'`,
      )
    )[0]!.id;
    historicalSnapshot = (
      await raw.$queryRawUnsafe<Array<{ value: string }>>(
        `SELECT (to_jsonb(x) - ARRAY['crew_device_id','crew_assignment_id'])::text AS value
         FROM passenger_boarding x WHERE id = '${boardingId}'::uuid`,
      )
    )[0]!.value;

    deploy(null, url);
  }, 120_000);

  afterAll(async () => {
    await t?.app.close();
    await raw?.$disconnect();
    if (root) {
      await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await root.$disconnect();
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('applies PR-18 through PR-20, preserves STAFF boarding and backfills no Crew data', async () => {
    expect(await applied()).toHaveLength(21);
    expect((await applied()).at(-1)).toBe(INCIDENT_MIGRATION);
    const row = (
      await raw.$queryRawUnsafe<
        Array<{ value: string; crew_device_id: string | null; crew_assignment_id: string | null }>
      >(
        `SELECT (to_jsonb(x) - ARRAY['crew_device_id','crew_assignment_id'])::text AS value,
                crew_device_id::text, crew_assignment_id::text
         FROM passenger_boarding x WHERE id = '${boardingId}'::uuid`,
      )
    )[0]!;
    expect(row.value).toBe(historicalSnapshot);
    expect(row.crew_device_id).toBeNull();
    expect(row.crew_assignment_id).toBeNull();
    expect(await raw.crewDevice.count()).toBe(0);
    expect(await raw.crewTripAssignment.count()).toBe(0);

    const permissions = await raw.authorizationPermission.findMany({
      where: { key: { startsWith: 'crew.' } },
      orderBy: { key: 'asc' },
      select: { key: true },
    });
    expect(permissions.map((permission) => permission.key)).toEqual([
      'crew.boarding.scan',
      'crew.border.report',
      'crew.device.manage',
      'crew.incident.report',
      'crew.tracking.report',
      'crew.trip.read',
    ]);
    expect(
      await raw.authorizationRolePermission.count({
        where: { permissionKey: { startsWith: 'crew.' } },
      }),
    ).toBe(18);
  });

  it('is idempotent and reports all 21 migrations applied', async () => {
    deploy(null, url);
    expect(await applied()).toHaveLength(21);
    const status = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: DATABASE_PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(status).toContain('Database schema is up to date');
  });
});
