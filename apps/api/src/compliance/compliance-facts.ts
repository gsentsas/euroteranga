import type { DatabaseTransaction } from '@euroteranga/database';
import type { ComplianceFacts, RuleVersionInput } from './compliance-engine.js';
import { ComplianceErrors } from './compliance.errors.js';
import { parseRuleDefinition, type RuleDocumentType } from './rule-language.js';

/** Any Prisma client or transaction (both expose the same delegates). */
type Db = Pick<
  DatabaseTransaction,
  'bookingPassenger' | 'routeWaypoint' | 'tripWaypointTiming' | '$queryRaw'
>;

export interface LoadedFacts {
  facts: ComplianceFacts;
  /** Public document reference -> internal id, for evidence rows. */
  documentIds: Map<string, string>;
}

/** Local calendar date (YYYY-MM-DD) of an instant in an IANA time zone. */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Completed years on a calendar date (birthday counted on the day itself). */
export function ageOn(dateOfBirth: Date, date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  let age = year - dateOfBirth.getUTCFullYear();
  const birthMonth = dateOfBirth.getUTCMonth() + 1;
  if (month < birthMonth || (month === birthMonth && day < dateOfBirth.getUTCDate())) age -= 1;
  return age;
}

/**
 * Country path of the booked segment: consecutive duplicates collapsed; the
 * transit countries are the interior of the path, de-duplicated in order.
 */
export function journeyCountries(countries: string[]): {
  origin: string;
  destination: string;
  transit: string[];
} {
  const path = countries.filter(
    (country, index) => index === 0 || country !== countries[index - 1],
  );
  return {
    origin: countries[0]!,
    destination: countries[countries.length - 1]!,
    transit: [...new Set(path.slice(1, -1))],
  };
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Builds the minimized facts of one booking passenger from PostgreSQL only.
 * Nothing comes from the client. Returns null when the link does not exist.
 */
export async function loadFacts(
  db: Db,
  bookingId: string,
  passengerId: string,
): Promise<LoadedFacts | null> {
  const link = await db.bookingPassenger.findUnique({
    where: { bookingId_passengerId: { bookingId, passengerId } },
    select: {
      booking: {
        select: {
          tripId: true,
          originSequence: true,
          destinationSequence: true,
          originRouteWaypointId: true,
          destinationRouteWaypointId: true,
          trip: {
            select: { routeVersionId: true, plannedDepartureAt: true, plannedArrivalAt: true },
          },
        },
      },
      passenger: {
        select: {
          dateOfBirth: true,
          nationalityCountry: { select: { iso2: true } },
          documents: {
            where: { status: 'ACCEPTED' },
            orderBy: { reference: 'asc' },
            select: { id: true, reference: true, type: true, expiresAt: true },
          },
        },
      },
    },
  });
  if (!link) return null;
  const { booking, passenger } = link;

  const [waypoints, timings] = await Promise.all([
    db.routeWaypoint.findMany({
      where: {
        routeVersionId: booking.trip.routeVersionId,
        sequence: { gte: booking.originSequence, lte: booking.destinationSequence },
      },
      orderBy: { sequence: 'asc' },
      select: {
        id: true,
        stop: { select: { timezone: true, country: { select: { iso2: true } } } },
        checkpoint: { select: { country: { select: { iso2: true } } } },
      },
    }),
    db.tripWaypointTiming.findMany({
      where: {
        tripId: booking.tripId,
        routeWaypointId: {
          in: [booking.originRouteWaypointId, booking.destinationRouteWaypointId],
        },
      },
      select: { routeWaypointId: true, plannedDepartureAt: true, plannedArrivalAt: true },
    }),
  ]);
  const origin = waypoints[0];
  const destination = waypoints[waypoints.length - 1];
  if (!origin?.stop || !destination?.stop || waypoints.length < 2) {
    throw ComplianceErrors.contextIncomplete();
  }
  const departureAt =
    timings.find((timing) => timing.routeWaypointId === booking.originRouteWaypointId)
      ?.plannedDepartureAt ?? booking.trip.plannedDepartureAt;
  const arrivalAt =
    timings.find((timing) => timing.routeWaypointId === booking.destinationRouteWaypointId)
      ?.plannedArrivalAt ?? booking.trip.plannedArrivalAt;
  if (!departureAt || !arrivalAt) throw ComplianceErrors.contextIncomplete();

  const countries = waypoints.map(
    (waypoint) => (waypoint.stop?.country.iso2 ?? waypoint.checkpoint?.country.iso2)!,
  );
  const journey = journeyCountries(countries);
  const travelDate = localDate(departureAt, origin.stop.timezone);
  const arrivalDate = localDate(arrivalAt, destination.stop.timezone);

  return {
    facts: {
      factsVersion: 1,
      travelDate,
      arrivalDate: arrivalDate < travelDate ? travelDate : arrivalDate,
      originCountry: journey.origin,
      destinationCountry: journey.destination,
      transitCountries: journey.transit,
      nationality: passenger.nationalityCountry.iso2,
      ageOnTravelDate: ageOn(passenger.dateOfBirth, travelDate),
      documents: passenger.documents.map((document) => ({
        reference: document.reference,
        type: document.type as RuleDocumentType,
        expiresAt: document.expiresAt ? isoDay(document.expiresAt) : null,
      })),
    },
    documentIds: new Map(passenger.documents.map((document) => [document.reference, document.id])),
  };
}

/**
 * For each rule, the highest-numbered PUBLISHED version whose inclusive
 * effective interval contains the travel date. RETIRED and DRAFT versions
 * never apply. Stored definitions are parsed again: an unreadable one stops
 * the evaluation instead of being skipped.
 */
export async function versionsInEffect(db: Db, travelDate: string): Promise<RuleVersionInput[]> {
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      version: number;
      definition: unknown;
      definition_sha256: string;
      reference: string;
    }>
  >`
    SELECT DISTINCT ON (v."rule_id")
      v."id", v."version", v."definition", v."definition_sha256", r."reference"
    FROM "compliance_rule_version" v
    JOIN "compliance_rule" r ON r."id" = v."rule_id"
    WHERE v."status" = 'PUBLISHED'
      AND v."effective_from" <= ${travelDate}::date
      AND (v."effective_to" IS NULL OR v."effective_to" >= ${travelDate}::date)
    ORDER BY v."rule_id", v."version" DESC`;
  return rows.map((row) => {
    const parsed = parseRuleDefinition(row.definition);
    if (!parsed.ok || parsed.sha256 !== row.definition_sha256) {
      throw new Error(`published compliance rule ${row.reference} v${row.version} is unreadable`);
    }
    return {
      versionId: row.id,
      ruleReference: row.reference,
      version: row.version,
      definitionSha256: row.definition_sha256,
      definition: parsed.definition,
    };
  });
}
