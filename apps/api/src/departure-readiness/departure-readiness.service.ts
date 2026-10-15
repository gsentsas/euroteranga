import {
  Prisma,
  type DatabaseTransaction,
  type RegulatoryPermitScopeType,
  type TripStatus,
} from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { AuthPrincipal } from '../auth/session/auth-principal.js';
import { AuditService } from '../authorization/audit.service.js';
import { CheckInService } from '../check-in/check-in.service.js';
import { DatabaseService } from '../database/database.service.js';
import { currentManifestSnapshot } from '../manifests/manifest-source.js';
import { manifestContentHash } from '../manifests/manifest-rules.js';
import { derivePermitValidity, isoDay } from '../regulatory-permits/regulatory-permit-rules.js';
import type { departurePermitPolicySchema } from './departure-readiness.dto.js';
import { DepartureReadinessErrors } from './departure-readiness.errors.js';
import {
  DEPARTURE_PERMIT_POLICY_SCHEMA_VERSION,
  DEPARTURE_READINESS_ENGINE_VERSION,
  departurePermitPolicyContentHash,
  departureReadinessFingerprint,
  departureReadinessSnapshot,
  deriveDepartureReadiness,
  generateDepartureAuthorizationReference,
  type DeparturePermitRequirementFact,
  type DepartureReadinessFacts,
} from './departure-readiness-rules.js';

type PermitPolicyInput = z.infer<typeof departurePermitPolicySchema>;

interface LockedTrip {
  id: string;
  reference: string;
  status: TripStatus;
  routeVersionId: string;
  vehicleId: string | null;
  seatMapVersionId: string | null;
}

interface Evaluation {
  trip: {
    id: string;
    reference: string;
    status: TripStatus;
    actualDepartureAt: Date | null;
    actualArrivalAt: Date | null;
  };
  facts: DepartureReadinessFacts;
  readiness: ReturnType<typeof deriveDepartureReadiness>;
  snapshot: ReturnType<typeof departureReadinessSnapshot>;
  fingerprint: string;
  latestAuthorization: {
    id: string;
    reference: string;
    version: number;
    engineVersion: string;
    readinessFingerprint: string;
    authorizedAt: Date;
  } | null;
}

const normalizeTripReference = (value: string) => value.trim().toUpperCase();

function referenceCollision(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta ?? {}).includes('reference')
  );
}

function serializationConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: unknown;
    sqlState?: unknown;
    message?: unknown;
    meta?: unknown;
    cause?: unknown;
  };
  if (candidate.code === '40001' || candidate.sqlState === '40001') return true;
  if (candidate.meta && typeof candidate.meta === 'object') {
    const meta = candidate.meta as { code?: unknown; sqlState?: unknown; message?: unknown };
    if (meta.code === '40001' || meta.sqlState === '40001') return true;
    if (
      typeof meta.message === 'string' &&
      /could not serialize|serialization failure/iu.test(meta.message)
    ) {
      return true;
    }
  }
  if (
    typeof candidate.message === 'string' &&
    /(?:40001|could not serialize|serialization failure)/iu.test(candidate.message)
  ) {
    return true;
  }
  return candidate.cause !== error && serializationConflict(candidate.cause);
}

function safeSnapshot(
  snapshot: ReturnType<typeof departureReadinessSnapshot>,
): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue;
}

async function lockTripByReference(
  tx: DatabaseTransaction,
  rawReference: string,
): Promise<LockedTrip> {
  const reference = normalizeTripReference(rawReference);
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      reference: string;
      status: TripStatus;
      route_version_id: string;
      vehicle_id: string | null;
      seat_map_version_id: string | null;
    }>
  >`
    SELECT "id", "reference", "status", "route_version_id", "vehicle_id",
      "seat_map_version_id"
    FROM "trip"
    WHERE "reference" = ${reference}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw DepartureReadinessErrors.tripNotFound();
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    routeVersionId: row.route_version_id,
    vehicleId: row.vehicle_id,
    seatMapVersionId: row.seat_map_version_id,
  };
}

function policyRequirementKey(requirement: {
  permitType: string;
  scopeType: string;
  countryIso2?: string | undefined;
}): string {
  return `${requirement.permitType}|${requirement.scopeType}|${requirement.countryIso2 ?? ''}`;
}

function permitScopeWhere(
  requirement: {
    scopeType: RegulatoryPermitScopeType;
    scopeCountryId: string | null;
  },
  trip: LockedTrip,
): Prisma.RegulatoryPermitWhereInput | null {
  switch (requirement.scopeType) {
    case 'OPERATOR':
      return { scopeCountryId: null, vehicleId: null, routeVersionId: null, tripId: null };
    case 'COUNTRY':
      return requirement.scopeCountryId ? { scopeCountryId: requirement.scopeCountryId } : null;
    case 'VEHICLE':
      return trip.vehicleId ? { vehicleId: trip.vehicleId } : null;
    case 'ROUTE_VERSION':
      return { routeVersionId: trip.routeVersionId };
    case 'TRIP':
      return { tripId: trip.id };
  }
}

@Injectable()
export class DepartureReadinessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly checkIns: CheckInService,
    private readonly audit: AuditService,
  ) {}

  private async serializable<T>(
    work: (tx: DatabaseTransaction) => Promise<T>,
    attempts = 3,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.database.client.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (serializationConflict(error) && attempt < attempts) continue;
        if (serializationConflict(error)) throw DepartureReadinessErrors.concurrencyConflict();
        throw error;
      }
    }
  }

  private async evaluationOf(db: DatabaseTransaction, rawReference: string): Promise<Evaluation> {
    const reference = normalizeTripReference(rawReference);
    const trip = await db.trip.findUnique({
      where: { reference },
      select: {
        id: true,
        reference: true,
        status: true,
        routeVersionId: true,
        vehicleId: true,
        seatMapVersionId: true,
        actualDepartureAt: true,
        actualArrivalAt: true,
        vehicle: {
          select: { code: true, status: true, seatMapVersionId: true },
        },
      },
    });
    if (!trip) throw DepartureReadinessErrors.tripNotFound();

    const travellers = await db.bookingPassenger.findMany({
      where: {
        booking: { tripId: trip.id, confirmedAt: { not: null }, cancelledAt: null },
      },
      select: {
        bookingId: true,
        passengerId: true,
        booking: { select: { reference: true } },
        passenger: { select: { reference: true } },
        checkIn: {
          select: { reference: true, boarding: { select: { reference: true } } },
        },
      },
      orderBy: [{ bookingId: 'asc' }, { passengerId: 'asc' }],
    });

    const passengerFacts: DepartureReadinessFacts['passengers'] = [];
    for (const traveller of travellers) {
      const current = await this.checkIns.readinessOf(db, {
        bookingId: traveller.bookingId,
        passengerId: traveller.passengerId,
        bookingReference: traveller.booking.reference,
        passengerReference: traveller.passenger.reference,
      });
      passengerFacts.push({
        passengerReference: traveller.passenger.reference,
        checkedIn: traveller.checkIn !== null,
        checkInReference: traveller.checkIn?.reference ?? null,
        boarded: Boolean(traveller.checkIn?.boarding),
        boardingReference: traveller.checkIn?.boarding?.reference ?? null,
        currentReadinessEligible: current.readiness.eligible,
        currentReadinessFingerprint: current.fingerprint,
      });
    }

    const latestManifest = await db.passengerManifest.findFirst({
      where: { tripId: trip.id },
      orderBy: { version: 'desc' },
      select: {
        reference: true,
        version: true,
        contentHash: true,
        passengerCount: true,
        boardedCount: true,
      },
    });
    const currentManifest = latestManifest ? await currentManifestSnapshot(db, trip.id) : null;
    const manifestFact = latestManifest
      ? {
          reference: latestManifest.reference,
          version: latestManifest.version,
          contentHash: latestManifest.contentHash,
          currentContentHash: currentManifest ? manifestContentHash(currentManifest) : null,
          passengerCount: latestManifest.passengerCount,
          boardedCount: latestManifest.boardedCount,
        }
      : null;

    const policy = await db.departurePermitPolicy.findFirst({
      where: { tripId: trip.id, status: 'PUBLISHED' },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        contentHash: true,
        requirementCount: true,
        requirements: {
          orderBy: { sequence: 'asc' },
          select: {
            sequence: true,
            permitType: true,
            scopeType: true,
            scopeCountryId: true,
            scopeCountry: { select: { iso2: true } },
          },
        },
      },
    });

    const dateRows = await db.$queryRaw<Array<{ day: string }>>`
      SELECT CURRENT_DATE::text AS day
    `;
    const evaluatedOn = dateRows[0]?.day;
    if (!evaluatedOn) throw new Error('database current date unavailable');

    let permitPolicyFact: DepartureReadinessFacts['permitPolicy'] = null;
    if (policy) {
      const requirements: DeparturePermitRequirementFact[] = [];
      const lockedShape: LockedTrip = {
        id: trip.id,
        reference: trip.reference,
        status: trip.status,
        routeVersionId: trip.routeVersionId,
        vehicleId: trip.vehicleId,
        seatMapVersionId: trip.seatMapVersionId,
      };
      for (const requirement of policy.requirements) {
        const scope = permitScopeWhere(requirement, lockedShape);
        let matchingReference: string | undefined;
        if (scope) {
          const permits = await db.regulatoryPermit.findMany({
            where: {
              permitType: requirement.permitType,
              status: 'ACTIVE',
              scopeType: requirement.scopeType,
              ...scope,
            },
            orderBy: { reference: 'asc' },
            select: {
              reference: true,
              status: true,
              validFrom: true,
              validUntil: true,
            },
          });
          matchingReference = permits.find(
            (permit) =>
              derivePermitValidity(
                {
                  status: permit.status,
                  validFrom: isoDay(permit.validFrom),
                  validUntil: isoDay(permit.validUntil),
                },
                evaluatedOn!,
              ) === 'VALID',
          )?.reference;
        }
        requirements.push({
          sequence: requirement.sequence,
          permitType: requirement.permitType,
          scopeType: requirement.scopeType,
          ...(requirement.scopeCountry ? { countryIso2: requirement.scopeCountry.iso2 } : {}),
          satisfied: matchingReference !== undefined,
          ...(matchingReference ? { permitReference: matchingReference } : {}),
        });
      }

      const currentContentHash = departurePermitPolicyContentHash({
        tripReference: trip.reference,
        version: policy.version,
        requirements: policy.requirements.map((requirement) => ({
          sequence: requirement.sequence,
          permitType: requirement.permitType,
          scopeType: requirement.scopeType,
          ...(requirement.scopeCountry ? { countryIso2: requirement.scopeCountry.iso2 } : {}),
        })),
      });
      permitPolicyFact = {
        version: policy.version,
        contentHash: policy.contentHash ?? '',
        currentContentHash,
        requirementCount: policy.requirementCount ?? -1,
        requirements,
      };
    }

    const facts: DepartureReadinessFacts = {
      trip: { reference: trip.reference, status: trip.status },
      vehicle: trip.vehicle
        ? {
            code: trip.vehicle.code,
            active: trip.vehicle.status === 'ACTIVE',
            seatMapCompatible:
              trip.seatMapVersionId === null ||
              trip.vehicle.seatMapVersionId === trip.seatMapVersionId,
          }
        : null,
      passengers: passengerFacts,
      manifest: manifestFact,
      permitPolicy: permitPolicyFact,
    };
    const readiness = deriveDepartureReadiness(facts);
    const snapshot = departureReadinessSnapshot(facts, readiness);
    const fingerprint = departureReadinessFingerprint(facts, readiness);
    const latestAuthorization = await db.departureAuthorization.findFirst({
      where: { tripId: trip.id },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        reference: true,
        version: true,
        engineVersion: true,
        readinessFingerprint: true,
        authorizedAt: true,
      },
    });

    return {
      trip: {
        id: trip.id,
        reference: trip.reference,
        status: trip.status,
        actualDepartureAt: trip.actualDepartureAt,
        actualArrivalAt: trip.actualArrivalAt,
      },
      facts,
      readiness,
      snapshot,
      fingerprint,
      latestAuthorization,
    };
  }

  async readiness(rawReference: string, actor: AuthPrincipal) {
    return this.database.client.$transaction(async (tx) => {
      const evaluation = await this.evaluationOf(tx, rawReference);
      await this.audit.record(
        {
          actor,
          action: 'DEPARTURE_READINESS_ACCESSED',
          resourceType: 'trip',
          resourceId: evaluation.trip.id,
          metadata: {
            tripReference: evaluation.trip.reference,
            status: evaluation.readiness.status,
            engineVersion: DEPARTURE_READINESS_ENGINE_VERSION,
            blockerCodes: evaluation.readiness.blockers.map((item) => item.code),
          },
        },
        tx,
      );
      return {
        trip: {
          reference: evaluation.trip.reference,
          status: evaluation.trip.status,
          actualDepartureAt: evaluation.trip.actualDepartureAt,
          actualArrivalAt: evaluation.trip.actualArrivalAt,
        },
        readiness: evaluation.snapshot,
        fingerprint: evaluation.fingerprint,
        latestAuthorization: evaluation.latestAuthorization
          ? {
              reference: evaluation.latestAuthorization.reference,
              version: evaluation.latestAuthorization.version,
              engineVersion: evaluation.latestAuthorization.engineVersion,
              readinessFingerprint: evaluation.latestAuthorization.readinessFingerprint,
              authorizedAt: evaluation.latestAuthorization.authorizedAt,
              current:
                evaluation.readiness.status === 'READY' &&
                evaluation.latestAuthorization.engineVersion ===
                  DEPARTURE_READINESS_ENGINE_VERSION &&
                evaluation.latestAuthorization.readinessFingerprint === evaluation.fingerprint,
            }
          : null,
      };
    });
  }

  async publishPermitPolicy(rawReference: string, input: PermitPolicyInput, actor: AuthPrincipal) {
    return this.serializable(async (tx) => {
      const trip = await lockTripByReference(tx, rawReference);
      if (trip.status !== 'SCHEDULED') throw DepartureReadinessErrors.tripNotScheduled();

      const ordered = [...input.requirements].sort((left, right) =>
        policyRequirementKey(left).localeCompare(policyRequirementKey(right), 'en'),
      );
      const seen = new Set<string>();
      for (const requirement of ordered) {
        const key = policyRequirementKey(requirement);
        if (seen.has(key)) throw DepartureReadinessErrors.policyDuplicateRequirement();
        seen.add(key);
      }

      const countryByIso2 = new Map<string, string>();
      const countryCodes = [
        ...new Set(
          ordered
            .map((requirement) => requirement.countryIso2)
            .filter((value): value is string => Boolean(value)),
        ),
      ];
      for (const iso2 of countryCodes) {
        const country = await tx.country.findUnique({ where: { iso2 }, select: { id: true } });
        if (!country) throw DepartureReadinessErrors.policyCountryNotFound();
        countryByIso2.set(iso2, country.id);
      }

      const aggregate = await tx.departurePermitPolicy.aggregate({
        where: { tripId: trip.id },
        _max: { version: true },
      });
      const version = (aggregate._max.version ?? 0) + 1;
      const requirements = ordered.map((requirement, index) => ({
        sequence: index + 1,
        permitType: requirement.permitType,
        scopeType: requirement.scopeType,
        ...(requirement.countryIso2 ? { countryIso2: requirement.countryIso2 } : {}),
      }));
      const contentHash = departurePermitPolicyContentHash({
        tripReference: trip.reference,
        version,
        requirements,
      });

      const policy = await tx.departurePermitPolicy.create({
        data: {
          tripId: trip.id,
          version,
          schemaVersion: DEPARTURE_PERMIT_POLICY_SCHEMA_VERSION,
        },
        select: { id: true },
      });
      if (requirements.length > 0) {
        await tx.departurePermitRequirement.createMany({
          data: requirements.map((requirement) => ({
            policyId: policy.id,
            sequence: requirement.sequence,
            permitType: requirement.permitType,
            scopeType: requirement.scopeType,
            ...(requirement.countryIso2
              ? { scopeCountryId: countryByIso2.get(requirement.countryIso2)! }
              : {}),
          })),
        });
      }
      const published = await tx.departurePermitPolicy.update({
        where: { id: policy.id },
        data: {
          status: 'PUBLISHED',
          contentHash,
          requirementCount: requirements.length,
          publishedByIdentityId: actor.identityId,
        },
        select: {
          id: true,
          version: true,
          schemaVersion: true,
          contentHash: true,
          requirementCount: true,
          publishedAt: true,
          requirements: {
            orderBy: { sequence: 'asc' },
            select: {
              sequence: true,
              permitType: true,
              scopeType: true,
              scopeCountry: { select: { iso2: true } },
            },
          },
        },
      });

      await this.audit.record(
        {
          actor,
          action: 'DEPARTURE_PERMIT_POLICY_PUBLISHED',
          resourceType: 'departure_permit_policy',
          resourceId: published.id,
          metadata: {
            tripReference: trip.reference,
            version: published.version,
            requirementCount: published.requirementCount,
            contentHash: published.contentHash,
          },
        },
        tx,
      );

      return {
        tripReference: trip.reference,
        version: published.version,
        schemaVersion: published.schemaVersion,
        contentHash: published.contentHash,
        requirementCount: published.requirementCount,
        publishedAt: published.publishedAt,
        requirements: published.requirements.map((requirement) => ({
          sequence: requirement.sequence,
          permitType: requirement.permitType,
          scopeType: requirement.scopeType,
          ...(requirement.scopeCountry ? { countryIso2: requirement.scopeCountry.iso2 } : {}),
        })),
      };
    });
  }

  async authorize(rawReference: string, actor: AuthPrincipal) {
    for (let referenceAttempt = 1; referenceAttempt <= 3; referenceAttempt += 1) {
      const reference = generateDepartureAuthorizationReference();
      try {
        return await this.serializable(async (tx) => {
          const trip = await lockTripByReference(tx, rawReference);
          if (trip.status !== 'SCHEDULED') throw DepartureReadinessErrors.tripNotScheduled();

          const evaluation = await this.evaluationOf(tx, trip.reference);
          if (evaluation.readiness.status !== 'READY') {
            throw DepartureReadinessErrors.readinessBlocked(evaluation.readiness.blockers);
          }
          if (
            evaluation.latestAuthorization &&
            evaluation.latestAuthorization.engineVersion === DEPARTURE_READINESS_ENGINE_VERSION &&
            evaluation.latestAuthorization.readinessFingerprint === evaluation.fingerprint
          ) {
            return {
              created: false,
              authorization: {
                reference: evaluation.latestAuthorization.reference,
                version: evaluation.latestAuthorization.version,
                engineVersion: evaluation.latestAuthorization.engineVersion,
                readinessFingerprint: evaluation.latestAuthorization.readinessFingerprint,
                authorizedAt: evaluation.latestAuthorization.authorizedAt,
              },
            };
          }

          const aggregate = await tx.departureAuthorization.aggregate({
            where: { tripId: trip.id },
            _max: { version: true },
          });
          const version = (aggregate._max.version ?? 0) + 1;
          const authorization = await tx.departureAuthorization.create({
            data: {
              reference,
              tripId: trip.id,
              version,
              engineVersion: DEPARTURE_READINESS_ENGINE_VERSION,
              readinessFingerprint: evaluation.fingerprint,
              readinessSnapshot: safeSnapshot(evaluation.snapshot),
              authorizedByIdentityId: actor.identityId,
            },
            select: {
              id: true,
              reference: true,
              version: true,
              engineVersion: true,
              readinessFingerprint: true,
              authorizedAt: true,
            },
          });
          await this.audit.record(
            {
              actor,
              action: 'DEPARTURE_AUTHORIZED',
              resourceType: 'departure_authorization',
              resourceId: authorization.id,
              metadata: {
                tripReference: trip.reference,
                authorizationReference: authorization.reference,
                version: authorization.version,
                engineVersion: authorization.engineVersion,
                readinessFingerprint: authorization.readinessFingerprint,
              },
            },
            tx,
          );
          return {
            created: true,
            authorization: {
              reference: authorization.reference,
              version: authorization.version,
              engineVersion: authorization.engineVersion,
              readinessFingerprint: authorization.readinessFingerprint,
              authorizedAt: authorization.authorizedAt,
            },
          };
        });
      } catch (error) {
        if (referenceCollision(error) && referenceAttempt < 3) continue;
        throw error;
      }
    }
    throw new PublicApiError(
      409,
      'DEPARTURE_AUTHORIZATION_REFERENCE_CONFLICT',
      'Impossible de créer une référence d’autorisation unique.',
    );
  }

  async depart(rawReference: string, actor: AuthPrincipal) {
    return this.serializable(async (tx) => {
      const trip = await lockTripByReference(tx, rawReference);
      if (trip.status !== 'SCHEDULED') throw DepartureReadinessErrors.tripNotScheduled();

      const evaluation = await this.evaluationOf(tx, trip.reference);
      if (evaluation.readiness.status !== 'READY') {
        throw DepartureReadinessErrors.readinessBlocked(evaluation.readiness.blockers);
      }
      if (!evaluation.latestAuthorization) {
        throw DepartureReadinessErrors.authorizationMissing();
      }
      if (
        evaluation.latestAuthorization.engineVersion !== DEPARTURE_READINESS_ENGINE_VERSION ||
        evaluation.latestAuthorization.readinessFingerprint !== evaluation.fingerprint
      ) {
        throw DepartureReadinessErrors.authorizationStale();
      }

      const updated = await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: 'IN_PROGRESS',
          departureAuthorizationId: evaluation.latestAuthorization.id,
        },
        select: {
          id: true,
          reference: true,
          status: true,
          actualDepartureAt: true,
          actualArrivalAt: true,
        },
      });
      await this.audit.record(
        {
          actor,
          action: 'TRIP_DEPARTED',
          resourceType: 'trip',
          resourceId: updated.id,
          before: { reference: trip.reference, status: 'SCHEDULED' },
          after: {
            reference: updated.reference,
            status: updated.status,
            actualDepartureAt: updated.actualDepartureAt,
            authorizationReference: evaluation.latestAuthorization.reference,
          },
        },
        tx,
      );
      return {
        trip: {
          reference: updated.reference,
          status: updated.status,
          actualDepartureAt: updated.actualDepartureAt,
          actualArrivalAt: updated.actualArrivalAt,
        },
        authorizationReference: evaluation.latestAuthorization.reference,
      };
    });
  }

  async complete(rawReference: string, actor: AuthPrincipal) {
    return this.serializable(async (tx) => {
      const trip = await lockTripByReference(tx, rawReference);
      if (trip.status !== 'IN_PROGRESS') {
        throw DepartureReadinessErrors.tripNotInProgress();
      }

      const updated = await tx.trip.update({
        where: { id: trip.id },
        data: { status: 'COMPLETED' },
        select: {
          id: true,
          reference: true,
          status: true,
          actualDepartureAt: true,
          actualArrivalAt: true,
          departureAuthorization: { select: { reference: true } },
        },
      });
      await this.audit.record(
        {
          actor,
          action: 'TRIP_COMPLETED',
          resourceType: 'trip',
          resourceId: updated.id,
          before: { reference: trip.reference, status: 'IN_PROGRESS' },
          after: {
            reference: updated.reference,
            status: updated.status,
            actualDepartureAt: updated.actualDepartureAt,
            actualArrivalAt: updated.actualArrivalAt,
            authorizationReference: updated.departureAuthorization?.reference ?? null,
          },
        },
        tx,
      );
      return {
        trip: {
          reference: updated.reference,
          status: updated.status,
          actualDepartureAt: updated.actualDepartureAt,
          actualArrivalAt: updated.actualArrivalAt,
        },
        authorizationReference: updated.departureAuthorization?.reference ?? null,
      };
    });
  }
}
