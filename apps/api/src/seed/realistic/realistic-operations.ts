import type { PrismaClient } from '@euroteranga/database';
import type {
  SystemCustomerActor,
  SystemOperatorActor,
} from '../../auth/session/auth-principal.js';
import type { AuditService } from '../../authorization/audit.service.js';
import { baggageRegistrationSchema } from '../../baggage/baggage.dto.js';
import type { BaggageService } from '../../baggage/baggage.service.js';
import { crewAssignmentCreateSchema } from '../../crew/crew.dto.js';
import type { CrewService } from '../../crew/crew.service.js';
import { incidentOpenStaffSchema } from '../../incidents/incident.dto.js';
import type { IncidentService } from '../../incidents/incident.service.js';
import { trackingConfigSchema } from '../../tracking/tracking.dto.js';
import type { TrackingService } from '../../tracking/tracking.service.js';
import {
  DIRECTIONS,
  seededRandom,
  upcomingPilotTrips,
  type UpcomingTrip,
} from './realistic-commerce.js';
import {
  REALISTIC_BAGGAGE_TYPES,
  REALISTIC_BAGS_PER_TRAVELLER,
  REALISTIC_CREW_PLAN,
  REALISTIC_INCIDENTS,
  REALISTIC_OPERATOR_EMAIL,
  REALISTIC_SOURCE,
  realisticCrewEmail,
} from './realistic-dataset.js';
import { ensureSyntheticIdentity } from './realistic-identities.js';
import type { RealisticReporter } from './realistic-report.js';

export interface RealisticOperationsServices {
  audit: AuditService;
  baggage: BaggageService;
  crew: CrewService;
  incidents: IncidentService;
  tracking: TrackingService;
}

/** Draws one value of a weighted list with a deterministic random number. */
function weighted<T>(items: ReadonlyArray<[T, number]>, random: () => number): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let draw = random() * total;
  return (items.find(([, weight]) => (draw -= weight) < 0) ?? items.at(-1)!)[0];
}

/**
 * SEED-REALISTIC-1 operations layer (local and CI only, after the commerce
 * layer): what an operations team prepares before a departure. Crew pairs
 * are assigned, travellers declare their bags online, tracking is set to
 * show checkpoints and two benign notes are opened, on the soonest
 * departures. Operational facts are recorded under the seed's own STAFF
 * identity (no password, no role); the audit records the system actor.
 * Check-in, boarding and manifests are not seeded: they need verified
 * documents or compliance decisions, which the seed never fabricates.
 */
export class RealisticOperations {
  constructor(
    private readonly db: PrismaClient,
    private readonly services: RealisticOperationsServices,
    private readonly reporter: RealisticReporter,
  ) {}

  async run(options: { dryRun: boolean; now: Date }): Promise<void> {
    const trips = new Map<string, UpcomingTrip[]>();
    for (const direction of DIRECTIONS) {
      trips.set(
        direction.name,
        await upcomingPilotTrips(this.db, direction.routeCode, options.now),
      );
    }
    const soonest = DIRECTIONS.flatMap((direction) => {
      const trip = trips.get(direction.name)?.[0];
      return trip ? [{ direction: direction.name, trip }] : [];
    });
    if (options.dryRun) {
      this.planned(trips);
      this.reportCheckInNotSeeded();
      return;
    }

    const operatorIdentityId = await this.reporter.guarded(
      'operations',
      'operator',
      'operations',
      [],
      () =>
        ensureSyntheticIdentity(this.db, this.services.audit, this.reporter, {
          layer: 'operations',
          entity: 'operator',
          key: 'operations',
          realm: 'STAFF',
          email: REALISTIC_OPERATOR_EMAIL,
        }),
    );
    if (!operatorIdentityId) return;
    const operator: SystemOperatorActor = {
      kind: 'system',
      source: REALISTIC_SOURCE,
      operatorIdentityId,
    };

    const members = new Map<string, string>();
    for (const member of new Set(Object.values(REALISTIC_CREW_PLAN).flat(2))) {
      const id = await this.reporter.guarded('operations', 'crew-member', member, [], () =>
        ensureSyntheticIdentity(this.db, this.services.audit, this.reporter, {
          layer: 'operations',
          entity: 'crew-member',
          key: member,
          realm: 'CREW',
          email: realisticCrewEmail(member),
        }),
      );
      if (id) members.set(member, id);
    }
    for (const direction of DIRECTIONS) {
      for (const [position, pair] of REALISTIC_CREW_PLAN[direction.name].entries()) {
        const trip = trips.get(direction.name)?.[position];
        if (!trip) continue;
        for (const member of pair) {
          await this.reporter.guarded(
            'operations',
            'crew',
            `${trip.reference} ${member}`,
            [`crew-member:${member}`],
            () => this.assignCrew(operator, trip, member, members.get(member)!),
          );
        }
      }
    }
    for (const { trip } of soonest) {
      await this.reporter.guarded('operations', 'baggage', trip.reference, [], () =>
        this.declareBags(trip),
      );
      await this.reporter.guarded('operations', 'tracking', trip.reference, [], () =>
        this.configureTracking(operator, trip),
      );
    }
    for (const incident of REALISTIC_INCIDENTS) {
      const trip = trips.get(incident.direction)?.[0];
      if (!trip) continue;
      await this.reporter.guarded(
        'operations',
        'incident',
        `${trip.reference} ${incident.key}`,
        [],
        () => this.openIncident(operator, trip, incident, options.now),
      );
    }
    this.reportCheckInNotSeeded();
  }

  /**
   * Check-in, boarding and departure need each passenger's documents to be
   * verified or a compliance decision: the seed never fabricates either. A
   * manifest lists checked-in passengers only, so none is generated.
   */
  private reportCheckInNotSeeded() {
    this.reporter.report({
      layer: 'operations',
      outcome: 'skipped',
      entity: 'check-in',
      key: 'all',
      detail:
        'needs verified passenger documents or a compliance decision, never fabricated by the seed',
    });
    this.reporter.report({
      layer: 'operations',
      outcome: 'skipped',
      entity: 'manifest',
      key: 'all',
      detail: 'a manifest lists checked-in passengers only',
    });
  }

  private planned(trips: Map<string, UpcomingTrip[]>) {
    const pairs = Object.values(REALISTIC_CREW_PLAN).flat().length;
    for (const [entity, count, detail] of [
      ['operator', 1, REALISTIC_OPERATOR_EMAIL],
      ['crew', pairs * 2, 'assignments on the two soonest departures of each direction'],
      ['baggage', 1, 'bags declared online on the soonest departures'],
      ['tracking', 2, 'checkpoint tracking on the soonest departures'],
      ['incident', REALISTIC_INCIDENTS.length, 'benign demonstration notes'],
    ] as const) {
      this.reporter.report({
        layer: 'operations',
        outcome: 'planned',
        entity,
        key: [...trips.values()].some((list) => list.length > 0) ? 'upcoming' : 'once trips exist',
        detail,
        count,
      });
    }
  }

  private async assignCrew(
    operator: SystemOperatorActor,
    trip: UpcomingTrip,
    member: string,
    crewIdentityId: string,
  ): Promise<string> {
    const result = await this.services.crew.assign(
      operator,
      trip.id,
      crewAssignmentCreateSchema.parse({ crewIdentityId }),
    );
    this.reporter.report({
      layer: 'operations',
      outcome: result.created ? 'created' : 'existing',
      entity: 'crew',
      key: `${trip.reference} ${member}`,
    });
    return result.assignment.id;
  }

  /** Each traveller of a confirmed booking declares 0 to 2 bags, as on the client app. */
  private async declareBags(trip: UpcomingTrip): Promise<string> {
    const links = await this.db.bookingPassenger.findMany({
      where: { booking: { tripId: trip.id, confirmedAt: { not: null }, cancelledAt: null } },
      orderBy: { passenger: { reference: 'asc' } },
      select: {
        booking: { select: { reference: true, customerIdentityId: true } },
        passenger: { select: { reference: true } },
        _count: { select: { baggage: true } },
      },
    });
    if (links.some((link) => link._count.baggage > 0)) {
      const existing = await this.db.baggage.count({
        where: { bookingPassenger: { booking: { tripId: trip.id } } },
      });
      this.reporter.report({
        layer: 'operations',
        outcome: 'existing',
        entity: 'baggage',
        key: trip.reference,
        detail: 'bags already declared on this departure',
        count: existing,
      });
      return trip.id;
    }
    let declared = 0;
    for (const link of links) {
      const random = seededRandom(`${trip.reference}#bags#${link.passenger.reference}`);
      const bags = weighted(REALISTIC_BAGS_PER_TRAVELLER, random);
      const customer: SystemCustomerActor = {
        kind: 'system',
        source: REALISTIC_SOURCE,
        customerIdentityId: link.booking.customerIdentityId,
      };
      for (let bag = 0; bag < bags; bag += 1) {
        await this.services.baggage.customerRegister(
          customer,
          link.booking.reference,
          link.passenger.reference,
          baggageRegistrationSchema.parse({ type: weighted(REALISTIC_BAGGAGE_TYPES, random) }),
        );
        declared += 1;
      }
    }
    this.reporter.report({
      layer: 'operations',
      outcome: 'created',
      entity: 'baggage',
      key: trip.reference,
      detail: `${declared} bags declared by ${links.length} travellers`,
      count: declared,
    });
    return trip.id;
  }

  private async configureTracking(operator: SystemOperatorActor, trip: UpcomingTrip) {
    const existing = await this.db.tripTrackingConfig.findUnique({
      where: { tripId: trip.id },
      select: { tripId: true },
    });
    if (existing) {
      this.reporter.report({
        layer: 'operations',
        outcome: 'existing',
        entity: 'tracking',
        key: trip.reference,
      });
      return trip.id;
    }
    await this.services.tracking.configure(
      operator,
      trip.id,
      trackingConfigSchema.parse({
        enabled: true,
        visibility: 'CHECKPOINT_ONLY',
        trackingDeviceId: null,
      }),
    );
    this.reporter.report({
      layer: 'operations',
      outcome: 'created',
      entity: 'tracking',
      key: trip.reference,
      detail: 'checkpoints shown to travellers',
    });
    return trip.id;
  }

  private async openIncident(
    operator: SystemOperatorActor,
    trip: UpcomingTrip,
    incident: (typeof REALISTIC_INCIDENTS)[number],
    now: Date,
  ) {
    const clientEventId = `seed-etr-v1-${trip.reference}-${incident.key}`;
    const existing = await this.db.incident.findFirst({
      where: { tripId: trip.id, clientEventId },
      select: { reference: true },
    });
    if (existing) {
      this.reporter.report({
        layer: 'operations',
        outcome: 'existing',
        entity: 'incident',
        key: existing.reference,
      });
      return existing.reference;
    }
    const opened = await this.services.incidents.openStaff(
      operator,
      incidentOpenStaffSchema.parse({
        tripReference: trip.reference,
        clientEventId,
        type: incident.type,
        severity: 'LOW',
        description: incident.description,
        openedAt: now.toISOString(),
      }),
    );
    this.reporter.report({
      layer: 'operations',
      outcome: 'created',
      entity: 'incident',
      key: opened.incident.reference,
      detail: `${incident.type}, LOW, ${trip.reference}`,
    });
    return opened.incident.reference;
  }
}
