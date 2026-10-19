import { DEFAULT_NAVIGATION, navigationSchema } from '@euroteranga/content';
import type { PrismaClient } from '@euroteranga/database';
import type { SystemCustomerActor } from '../../auth/session/auth-principal.js';
import type { BookingService } from '../../bookings/booking.service.js';
import type { ContentService } from '../../content/content.service.js';
import { vehicleStatusSchema, vehicleUpdateSchema } from '../../fleet/fleet.dto.js';
import type { FleetService } from '../../fleet/fleet.service.js';
import { seatMapUpdateSchema } from '../../seat-maps/seat-map.dto.js';
import type { SeatMapService } from '../../seat-maps/seat-map.service.js';
import {
  REALISTIC_ACTOR,
  REALISTIC_AMENITIES,
  REALISTIC_SEAT_MAP,
  REALISTIC_SOURCE,
  REALISTIC_VEHICLES,
} from './realistic-dataset.js';
import type { RealisticReporter } from './realistic-report.js';

export interface RealisticCleanupServices {
  db: PrismaClient;
  content: ContentService;
  fleet: FleetService;
  seatMaps: SeatMapService;
  /** Present where the commerce layer can exist (local and CI). */
  bookings?: BookingService | undefined;
}

const REASON = 'Retrait des données de démonstration (seed réaliste)';

/** JSON with sorted keys: two equal documents compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
const SEED_EMAIL = { startsWith: 'etr-v1-', endsWith: '@example.test' } as const;

/**
 * SEED-REALISTIC-1 `--cleanup-seed-only`: retires what this seed created and
 * nobody changed since, through the domain (archive, retire, deactivate,
 * cancel). Nothing is ever deleted: vehicles, trips and bookings cannot be,
 * by design. Ownership is proven by the audit trail (created by the
 * `realistic-seed` system actor) and lost as soon as a person changed the
 * record. The DATA-1 pilot corridor belongs to the pilot bootstrap and is
 * never touched here (its trips are cancelled in OPS, see its runbook).
 */
export class RealisticCleanup {
  constructor(
    private readonly services: RealisticCleanupServices,
    private readonly reporter: RealisticReporter,
  ) {}

  async run(options: { dryRun: boolean }): Promise<void> {
    const dry = options.dryRun;
    await this.pages(dry);
    await this.navigation(dry);
    for (const vehicle of REALISTIC_VEHICLES) {
      await this.reporter.guarded('catalogue', 'vehicle', vehicle.code, [], () =>
        this.retireVehicle(vehicle.code, dry),
      );
    }
    await this.reporter.guarded('catalogue', 'seat-map', REALISTIC_SEAT_MAP.code, [], () =>
      this.deactivateSeatMap(dry),
    );
    for (const [code, amenities] of Object.entries(REALISTIC_AMENITIES)) {
      await this.reporter.guarded('catalogue', 'amenities', code, [], () =>
        this.resetAmenities(code, amenities, dry),
      );
    }
    await this.commerce(dry);
  }

  // -- ownership --------------------------------------------------------------

  /** Created by this seed, according to the audit trail. */
  private async createdBySeed(resourceType: string, resourceId: string, action: string) {
    const created = await this.services.db.auditEvent.count({
      where: {
        resourceType,
        resourceId,
        action,
        metadata: { path: ['systemActor'], equals: REALISTIC_SOURCE },
      },
    });
    return created > 0;
  }

  /** A person (any audited identity) changed the record: it is operator data now. */
  private async touchedByPerson(resourceType: string, resourceId: string) {
    const touched = await this.services.db.auditEvent.count({
      where: { resourceType, resourceId, actorIdentityId: { not: null } },
    });
    return touched > 0;
  }

  private keep(entity: string, key: string, detail: string) {
    this.reporter.report({ layer: 'catalogue', outcome: 'kept', entity, key, detail });
  }

  private retired(entity: string, key: string, detail: string, dry: boolean) {
    this.reporter.report({
      layer: 'catalogue',
      outcome: dry ? 'planned' : 'retired',
      entity,
      key,
      detail,
    });
  }

  // -- public website -------------------------------------------------------

  private async pages(dry: boolean) {
    const entries = await this.services.db.contentEntry.findMany({
      where: { kind: 'PAGE', archivedAt: null },
      select: { id: true, key: true },
      orderBy: { key: 'asc' },
    });
    for (const entry of entries) {
      if (!(await this.createdBySeed('content_entry', entry.id, 'CONTENT_ENTRY_CREATED'))) continue;
      await this.reporter.guarded('catalogue', 'page', entry.key, [], async () => {
        if (await this.touchedByPerson('content_entry', entry.id)) {
          this.keep('page', entry.key, 'edited by a person since (operator content)');
          return null;
        }
        if (!dry)
          await this.services.content.archive(entry.id, { reason: REASON }, REALISTIC_ACTOR);
        this.retired('page', entry.key, 'archived', dry);
        return entry.id;
      });
    }
  }

  /** A navigation the seed published goes back to the default one; never an operator's. */
  private async navigation(dry: boolean) {
    const { db, content } = this.services;
    const entry = await db.contentEntry.findUnique({
      where: { kind_key: { kind: 'NAVIGATION', key: 'navigation' } },
      select: { id: true },
    });
    if (!entry || !(await this.createdBySeed('content_entry', entry.id, 'CONTENT_ENTRY_CREATED'))) {
      return;
    }
    await this.reporter.guarded('catalogue', 'navigation', 'site', [], async () => {
      if (await this.touchedByPerson('content_entry', entry.id)) {
        this.keep('navigation', 'site', 'edited by a person since (operator navigation)');
        return null;
      }
      const current = await content.entry(entry.id);
      const published = navigationSchema.safeParse(current.published?.document);
      if (published.success && canonical(published.data) === canonical(DEFAULT_NAVIGATION)) {
        this.keep('navigation', 'site', 'already the default navigation');
        return null;
      }
      if (!dry) {
        const saved = await content.saveDraft(
          entry.id,
          {
            document: DEFAULT_NAVIGATION as unknown as Record<string, unknown>,
            note: REASON,
            expectedDraftUpdatedAt: current.draft ? current.draft.updatedAt.toISOString() : null,
          },
          { actor: REALISTIC_ACTOR, canManageSeo: false },
        );
        await content.publish(
          entry.id,
          { expectedDraftUpdatedAt: saved.draft!.updatedAt.toISOString() },
          REALISTIC_ACTOR,
        );
      }
      this.retired('navigation', 'site', 'default navigation published again', dry);
      return entry.id;
    });
  }

  // -- fleet ----------------------------------------------------------------

  private async retireVehicle(code: string, dry: boolean) {
    const { db, fleet } = this.services;
    const vehicle = await db.vehicle.findUnique({
      where: { code },
      select: { id: true, status: true, _count: { select: { trips: true } } },
    });
    if (!vehicle || !(await this.createdBySeed('vehicle', vehicle.id, 'VEHICLE_CREATED'))) {
      return null;
    }
    if (vehicle.status === 'RETIRED') {
      this.keep('vehicle', code, 'already retired');
      return null;
    }
    if (await this.touchedByPerson('vehicle', vehicle.id)) {
      this.keep('vehicle', code, 'changed by a person since (operator vehicle)');
      return null;
    }
    if (vehicle._count.trips > 0) {
      this.keep('vehicle', code, 'assigned to trips: retire it in OPS once they are settled');
      return null;
    }
    if (!dry) {
      await fleet.changeStatus(
        vehicle.id,
        vehicleStatusSchema.parse({
          status: 'RETIRED',
          reason: REASON,
          expectedStatus: vehicle.status,
        }),
        REALISTIC_ACTOR,
      );
    }
    this.retired('vehicle', code, 'retired (vehicles are never deleted)', dry);
    return vehicle.id;
  }

  private async deactivateSeatMap(dry: boolean) {
    const { db, seatMaps } = this.services;
    const seatMap = await db.seatMap.findUnique({
      where: { code: REALISTIC_SEAT_MAP.code },
      select: { id: true, code: true, name: true, active: true },
    });
    if (!seatMap || !(await this.createdBySeed('seat_map', seatMap.id, 'SEAT_MAP_CREATED'))) {
      return null;
    }
    if (!seatMap.active) {
      this.keep('seat-map', seatMap.code, 'already inactive');
      return null;
    }
    if (await this.touchedByPerson('seat_map', seatMap.id)) {
      this.keep('seat-map', seatMap.code, 'changed by a person since (operator seat map)');
      return null;
    }
    const users = await db.vehicle.count({
      where: {
        status: { not: 'RETIRED' },
        seatMapVersion: { seatMapId: seatMap.id },
        // The demo coach is retired in the same run.
        code: { notIn: dry ? REALISTIC_VEHICLES.map((vehicle) => vehicle.code) : [] },
      },
    });
    if (users > 0) {
      this.keep('seat-map', seatMap.code, 'used by a vehicle in service');
      return null;
    }
    if (!dry) {
      await seatMaps.updateSeatMap(
        seatMap.id,
        seatMapUpdateSchema.parse({ code: seatMap.code, name: seatMap.name, active: false }),
        REALISTIC_ACTOR,
      );
    }
    this.retired('seat-map', seatMap.code, 'deactivated', dry);
    return seatMap.id;
  }

  /** DEMO equipment is removed only if it is still exactly what the seed set. */
  private async resetAmenities(code: string, amenities: readonly string[], dry: boolean) {
    const { db, fleet } = this.services;
    const vehicle = await db.vehicle.findUnique({
      where: { code },
      select: { id: true, status: true, amenities: true },
    });
    if (!vehicle || vehicle.amenities.length === 0) return null;
    const expected = vehicleUpdateSchema.parse({ amenities }).amenities ?? [];
    const setBySeed = await db.auditEvent.findFirst({
      where: {
        resourceType: 'vehicle',
        resourceId: vehicle.id,
        action: 'VEHICLE_UPDATED',
        metadata: { path: ['systemActor'], equals: REALISTIC_SOURCE },
      },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });
    if (!setBySeed) return null;
    const changedSince = await db.auditEvent.count({
      where: {
        resourceType: 'vehicle',
        resourceId: vehicle.id,
        actorIdentityId: { not: null },
        occurredAt: { gt: setBySeed.occurredAt },
      },
    });
    if (
      changedSince > 0 ||
      vehicle.amenities.length !== expected.length ||
      vehicle.amenities.some((value, index) => value !== expected[index])
    ) {
      this.keep('amenities', code, 'changed by a person since (operator equipment)');
      return null;
    }
    if (vehicle.status === 'RETIRED') {
      this.keep('amenities', code, 'vehicle retired');
      return null;
    }
    if (!dry) {
      await fleet.updateVehicle(
        vehicle.id,
        vehicleUpdateSchema.parse({ amenities: [] }),
        REALISTIC_ACTOR,
      );
    }
    this.retired('amenities', code, 'demo equipment removed', dry);
    return vehicle.id;
  }

  // -- commerce and operations (disposable local and CI databases) ----------

  private async commerce(dry: boolean) {
    const { db, bookings } = this.services;
    const seedBookings = await db.booking.findMany({
      where: { customerIdentity: { normalizedEmail: SEED_EMAIL } },
      select: {
        reference: true,
        customerIdentityId: true,
        confirmedAt: true,
        cancelledAt: true,
        holdExpiresAt: true,
      },
    });
    if (seedBookings.length === 0) return;
    const now = Date.now();
    const open = seedBookings.filter(
      (booking) =>
        !booking.confirmedAt && !booking.cancelledAt && booking.holdExpiresAt.getTime() > now,
    );
    for (const booking of open) {
      await this.reporter.guarded('commerce', 'booking', booking.reference, [], async () => {
        if (!dry) {
          if (!bookings) throw new Error('the booking service is required to cancel holds');
          const actor: SystemCustomerActor = {
            kind: 'system',
            source: REALISTIC_SOURCE,
            customerIdentityId: booking.customerIdentityId,
          };
          await bookings.cancelByCustomer(actor, booking.reference);
        }
        this.reporter.report({
          layer: 'commerce',
          outcome: dry ? 'planned' : 'retired',
          entity: 'booking',
          key: booking.reference,
          detail: 'open hold cancelled',
        });
        return booking.reference;
      });
    }
    const confirmed = seedBookings.filter((booking) => booking.confirmedAt && !booking.cancelledAt);
    if (confirmed.length > 0) {
      this.reporter.report({
        layer: 'commerce',
        outcome: 'kept',
        entity: 'booking',
        key: 'confirmed',
        detail:
          'confirmed bookings, their passengers, bags and crew duties stay: a paid booking is cancelled only after a refund. They exist only in disposable local or CI databases: drop the database.',
        count: confirmed.length,
      });
    }
  }
}
