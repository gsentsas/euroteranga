import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { PrismaClient };
// Generated enums, model types and the Prisma namespace (error classes,
// transaction types) for consumers of the database layer.
export {
  AuthChallengeType,
  AuthIdentityStatus,
  AuthRealm,
  AuthSessionRevocationReason,
  CheckpointType,
  FareTableVersionStatus,
  Prisma,
  RegulatoryPermitScopeType,
  RegulatoryPermitStatus,
  RouteVersionStatus,
  SeatMapCellKind,
  SeatMapVersionStatus,
  TripStatus,
  VehicleStatus,
} from './generated/prisma/client.js';
export type {
  AuthIdentity,
  AuthSession,
  Booking,
  BookingSeat,
  Checkpoint,
  Country,
  FareEntry,
  FareTable,
  FareTableVersion,
  RegulatoryPermit,
  Route,
  RouteVersion,
  RouteWaypoint,
  SeatInventoryLock,
  SeatMap,
  SeatMapCell,
  SeatMapVersion,
  Stop,
  Trip,
  TripWaypointTiming,
  Vehicle,
} from './generated/prisma/client.js';

/** Interactive transaction client, as passed to `$transaction(async (tx) => ...)`. */
export type DatabaseTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

export interface DatabaseClientOptions {
  /** PostgreSQL connection string. Never log it: it contains credentials. */
  databaseUrl: string;
  /** Upper bound for opening a new connection, in milliseconds. */
  connectTimeoutMs?: number;
}

/**
 * Creates the single Prisma client used by a process. Callers own its
 * lifecycle and must call `$disconnect()` on shutdown to release pooled
 * connections (the API does this from its module destroy hook).
 */
export function createDatabaseClient(options: DatabaseClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 5_000,
  });
  return new PrismaClient({ adapter });
}

export class DatabaseTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Database did not answer within ${timeoutMs} ms`);
    this.name = 'DatabaseTimeoutError';
  }
}

/**
 * Runs `SELECT 1` through the official client. Rejects when the database is
 * unreachable or slower than `timeoutMs`, so readiness checks cannot hang.
 */
export async function pingDatabase(client: PrismaClient, timeoutMs = 2_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DatabaseTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    await Promise.race([client.$queryRaw`SELECT 1`, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
