import {
  DEFAULT_NAVIGATION,
  PAGE_TEMPLATES,
  navigationSchema,
  type Navigation,
} from '@euroteranga/content';
import type { PrismaClient } from '@euroteranga/database';
import type { SystemActor } from '../../auth/session/auth-principal.js';
import type { ContentService } from '../../content/content.service.js';
import {
  vehicleCreateSchema,
  vehicleSeatMapSchema,
  vehicleUpdateSchema,
} from '../../fleet/fleet.dto.js';
import {
  PilotBootstrap,
  type PilotBootstrapServices,
  type PilotOutcome,
} from '../../pilot/pilot-bootstrap.js';
import { seatMapCellsSchema, seatMapCreateSchema } from '../../seat-maps/seat-map.dto.js';
import type { SeatMapService } from '../../seat-maps/seat-map.service.js';
import { RealisticCommerce, type RealisticCommerceServices } from './realistic-commerce.js';
import { RealisticOperations, type RealisticOperationsServices } from './realistic-operations.js';
import {
  REALISTIC_AMENITIES,
  REALISTIC_PAGE_TEMPLATES,
  REALISTIC_SEAT_MAP,
  REALISTIC_SOURCE,
  REALISTIC_VEHICLES,
  realisticNavigation,
  type RealisticSeatCell,
  type VehicleAmenity,
} from './realistic-dataset.js';
import {
  RealisticConflict,
  RealisticReporter,
  type RealisticLayer,
  type RealisticOutcome,
  type RealisticReportLine,
} from './realistic-report.js';

export type { RealisticLayer, RealisticOutcome, RealisticReportLine };

export const REALISTIC_ACTOR: SystemActor = { kind: 'system', source: REALISTIC_SOURCE };

export interface RealisticSeedReport {
  dryRun: boolean;
  lines: RealisticReportLine[];
  hasConflicts: boolean;
}

export interface RealisticSeedServices extends PilotBootstrapServices {
  content: ContentService;
  /**
   * Bookings, passengers and payments: only where SANDBOX payments exist
   * (local and CI). Absent elsewhere, and the layer is reported as skipped.
   */
  commerce?: RealisticCommerceServices | undefined;
  /** Crew, bags, tracking, incidents and manifests: with the commerce layer only. */
  operations?: RealisticOperationsServices | undefined;
}

export interface RealisticSeedOptions {
  /** Calendar date (YYYY-MM-DD, UTC) from which the pilot plans departures. */
  anchorDate: string;
  tripsPerDirection: number;
  dryRun: boolean;
  now?: Date;
  /** Why the commerce layer cannot run here (staging, production, no SANDBOX). */
  commerceUnavailable?: string | undefined;
}

const PILOT_OUTCOMES: Record<PilotOutcome, RealisticOutcome> = {
  created: 'created',
  completed: 'updated',
  existing: 'existing',
  planned: 'planned',
  skipped: 'skipped',
  conflict: 'conflict',
};

const cellSignature = (cell: {
  deck: number;
  row: number;
  column: number;
  kind: string;
  seatLabel?: string | null;
}) => `${cell.deck}:${cell.row}:${cell.column}:${cell.kind}:${cell.seatLabel ?? ''}`;

const sameList = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * SEED-REALISTIC-1: the demonstration dataset, stacked on the DATA-1 pilot
 * corridor. The pilot bootstrap runs first (corridor, coaches, fares and
 * upcoming trips); this layer then adds what makes the platform look
 * operated, through the same domain services and audit as OPS, as the
 * `realistic-seed` system actor. Existing data is reused when it matches,
 * completed when a step is missing, and reported as a conflict otherwise.
 */
export class RealisticSeed {
  private readonly reporter = new RealisticReporter();

  constructor(private readonly services: RealisticSeedServices) {}

  async run(options: RealisticSeedOptions): Promise<RealisticSeedReport> {
    const dry = options.dryRun;
    const pilot = await new PilotBootstrap(this.services).run({
      anchorDate: options.anchorDate,
      tripsPerDirection: options.tripsPerDirection,
      dryRun: dry,
      ...(options.now ? { now: options.now } : {}),
    });
    for (const line of pilot.lines) {
      this.report('catalogue', PILOT_OUTCOMES[line.outcome], line.entity, line.key, line.detail);
      if (line.outcome === 'conflict' || line.outcome === 'skipped') {
        this.reporter.block(line.entity, line.key);
      }
    }

    const seatMapVersionId = await this.guarded('seat-map', REALISTIC_SEAT_MAP.code, [], () =>
      this.ensureSeatMap(dry),
    );
    for (const vehicle of REALISTIC_VEHICLES) {
      await this.guarded('vehicle', vehicle.code, [`seat-map:${vehicle.seatMapCode}`], () =>
        this.ensureVehicle(vehicle, seatMapVersionId ?? null, dry),
      );
    }
    for (const [code, amenities] of Object.entries(REALISTIC_AMENITIES)) {
      await this.guarded('amenities', code, [`vehicle:${code}`], () =>
        this.ensureAmenities(code, amenities, dry),
      );
    }

    const published = new Set<string>();
    for (const templateId of REALISTIC_PAGE_TEMPLATES) {
      const path = await this.guarded('page', templateId, [], () =>
        this.ensurePage(templateId, dry),
      );
      if (path) published.add(path);
    }
    await this.guarded('navigation', 'site', [], () => this.ensureNavigation(published, dry));

    const { commerce, operations } = this.services;
    if (commerce && !options.commerceUnavailable) {
      const now = options.now ?? new Date();
      await new RealisticCommerce(this.services.db, commerce, this.reporter).run({
        dryRun: dry,
        now,
      });
      if (operations) {
        await new RealisticOperations(this.services.db, operations, this.reporter).run({
          dryRun: dry,
          now,
        });
      }
    } else {
      this.reporter.report({
        layer: 'commerce',
        outcome: 'skipped',
        entity: 'booking',
        key: 'all',
        detail: options.commerceUnavailable ?? 'commerce services not configured',
      });
    }

    return {
      dryRun: dry,
      lines: this.reporter.lines,
      hasConflicts: this.reporter.hasConflicts,
    };
  }

  // -- reporting and dependency tracking ------------------------------------

  private report(
    layer: RealisticLayer,
    outcome: RealisticOutcome,
    entity: string,
    key: string,
    detail?: string,
  ) {
    this.reporter.report({ layer, outcome, entity, key, ...(detail ? { detail } : {}) });
  }

  private guarded<R>(
    entity: string,
    key: string,
    dependsOn: readonly string[],
    work: () => Promise<R | null>,
  ): Promise<R | null> {
    return this.reporter.guarded('catalogue', entity, key, dependsOn, work);
  }

  // -- fleet ----------------------------------------------------------------

  private async ensureSeatMap(dry: boolean): Promise<string | null> {
    const { db, seatMaps } = this.services;
    const expected = REALISTIC_SEAT_MAP.cells.map(cellSignature).sort();
    const existing = await db.seatMap.findUnique({
      where: { code: REALISTIC_SEAT_MAP.code },
      include: {
        versions: { where: { status: { in: ['PUBLISHED', 'DRAFT'] } }, include: { cells: true } },
      },
    });
    const published = existing?.versions.find((version) => version.status === 'PUBLISHED');
    if (published) {
      if (!sameList(published.cells.map(cellSignature).sort(), expected)) {
        throw new RealisticConflict('its published version differs from the demo layout');
      }
      this.report('catalogue', 'existing', 'seat-map', REALISTIC_SEAT_MAP.code);
      return published.id;
    }
    if (existing && !existing.active) throw new RealisticConflict('seat map is inactive');
    if (dry) {
      this.report('catalogue', 'planned', 'seat-map', REALISTIC_SEAT_MAP.code);
      return null;
    }
    await publishSeatMap(seatMaps, db, existing, REALISTIC_SEAT_MAP, expected);
    const version = await db.seatMapVersion.findFirstOrThrow({
      where: { seatMap: { code: REALISTIC_SEAT_MAP.code }, status: 'PUBLISHED' },
    });
    this.report('catalogue', existing ? 'updated' : 'created', 'seat-map', REALISTIC_SEAT_MAP.code);
    return version.id;
  }

  private async ensureVehicle(
    vehicle: (typeof REALISTIC_VEHICLES)[number],
    seatMapVersionId: string | null,
    dry: boolean,
  ): Promise<string | null> {
    const { db, fleet } = this.services;
    let current = await db.vehicle.findUnique({ where: { code: vehicle.code } });
    if (current) {
      const divergence = vehicleDivergence(current, vehicle);
      if (divergence) throw new RealisticConflict(divergence);
      if (current.status === 'RETIRED') throw new RealisticConflict('vehicle is RETIRED');
      if (
        current.seatMapVersionId &&
        seatMapVersionId &&
        current.seatMapVersionId !== seatMapVersionId
      ) {
        throw new RealisticConflict('vehicle uses another seat map');
      }
      if (current.seatMapVersionId === seatMapVersionId || (dry && current.seatMapVersionId)) {
        this.report('catalogue', 'existing', 'vehicle', vehicle.code, current.status);
        return current.id;
      }
    }
    if (dry || !seatMapVersionId) {
      this.report('catalogue', 'planned', 'vehicle', vehicle.code);
      return null;
    }
    const createdNow = !current;
    if (!current) {
      await fleet.createVehicle(
        vehicleCreateSchema.parse({
          code: vehicle.code,
          name: vehicle.name,
          manufacturer: vehicle.manufacturer,
          model: vehicle.model,
          modelYear: null,
        }),
        REALISTIC_ACTOR,
      );
      current = await db.vehicle.findUniqueOrThrow({ where: { code: vehicle.code } });
    }
    if (current.seatMapVersionId !== seatMapVersionId) {
      await fleet.assignSeatMap(
        current.id,
        vehicleSeatMapSchema.parse({ seatMapVersionId, expectedSeatMapVersionId: null }),
        REALISTIC_ACTOR,
      );
    }
    this.report('catalogue', createdNow ? 'created' : 'updated', 'vehicle', vehicle.code);
    return current.id;
  }

  /**
   * DEMO equipment: set on a coach that lists none. A coach whose equipment
   * was entered in OPS keeps it (operator data, reported as a conflict).
   */
  private async ensureAmenities(
    code: string,
    amenities: readonly VehicleAmenity[],
    dry: boolean,
  ): Promise<string | null> {
    const { db, fleet } = this.services;
    const vehicle = await db.vehicle.findUnique({
      where: { code },
      select: { id: true, amenities: true, status: true },
    });
    if (!vehicle) {
      this.report('catalogue', 'planned', 'amenities', code);
      return null;
    }
    const expected = vehicleUpdateSchema.parse({ amenities }).amenities ?? [];
    if (sameList(vehicle.amenities, expected)) {
      this.report('catalogue', 'existing', 'amenities', code);
      return vehicle.id;
    }
    if (vehicle.amenities.length > 0) {
      throw new RealisticConflict('the coach already lists other equipment (kept)');
    }
    if (vehicle.status === 'RETIRED') throw new RealisticConflict('vehicle is RETIRED');
    if (dry) {
      this.report('catalogue', 'planned', 'amenities', code);
      return null;
    }
    await fleet.updateVehicle(
      vehicle.id,
      vehicleUpdateSchema.parse({ amenities }),
      REALISTIC_ACTOR,
    );
    this.report('catalogue', 'updated', 'amenities', code, expected.join(', '));
    return vehicle.id;
  }

  // -- public website -------------------------------------------------------

  /**
   * A UI-PUBLIC-2 page created from its template when its path is free, then
   * published without indexing (the created draft keeps `indexable: false`).
   * An existing page is never touched. Returns the path when it is published.
   */
  private async ensurePage(templateId: string, dry: boolean): Promise<string | null> {
    const { db, content } = this.services;
    const template = PAGE_TEMPLATES.find((candidate) => candidate.id === templateId);
    if (!template) throw new RealisticConflict(`unknown page template ${templateId}`);
    const entry = await db.contentEntry.findUnique({
      where: { kind_key: { kind: 'PAGE', key: template.path } },
      select: {
        id: true,
        archivedAt: true,
        revisions: { where: { status: 'PUBLISHED' }, select: { id: true } },
      },
    });
    if (entry) {
      const live = entry.archivedAt === null && entry.revisions.length > 0;
      this.report(
        'catalogue',
        'existing',
        'page',
        template.path,
        live ? 'published (kept)' : 'not published (kept)',
      );
      return live ? template.path : null;
    }
    if (dry) {
      this.report('catalogue', 'planned', 'page', template.path, 'published, not indexed');
      return template.path;
    }
    const created = await content.create(
      {
        kind: 'PAGE',
        path: template.path,
        title: template.document.title,
        description: template.document.seo.description,
      },
      REALISTIC_ACTOR,
    );
    const draft = created.draft;
    if (!draft) throw new RealisticConflict('the created page has no draft');
    const saved = await content.saveDraft(
      created.id,
      {
        document: {
          ...(draft.document as Record<string, unknown>),
          title: template.document.title,
          blocks: template.document.blocks,
        },
        note: `Modèle « ${template.label} » (données de démonstration)`,
        expectedDraftUpdatedAt: draft.updatedAt.toISOString(),
      },
      { actor: REALISTIC_ACTOR, canManageSeo: false },
    );
    await content.publish(
      created.id,
      { expectedDraftUpdatedAt: saved.draft!.updatedAt.toISOString() },
      REALISTIC_ACTOR,
    );
    this.report('catalogue', 'created', 'page', template.path, 'published, not indexed');
    return template.path;
  }

  /** The public navigation, only when the site has none: operator navigation is kept. */
  private async ensureNavigation(
    publishedPaths: ReadonlySet<string>,
    dry: boolean,
  ): Promise<string | null> {
    const { db, content } = this.services;
    const existing = await db.contentEntry.findUnique({
      where: { kind_key: { kind: 'NAVIGATION', key: 'navigation' } },
      select: { id: true },
    });
    if (existing) {
      this.report('catalogue', 'existing', 'navigation', 'site', 'operator navigation kept');
      return existing.id;
    }
    const navigation: Navigation = navigationSchema.parse(realisticNavigation(publishedPaths));
    if (dry) {
      this.report('catalogue', 'planned', 'navigation', 'site', linksOf(navigation));
      return null;
    }
    const created = await content.create({ kind: 'NAVIGATION' }, REALISTIC_ACTOR);
    const draft = created.draft;
    if (!draft) throw new RealisticConflict('the created navigation has no draft');
    const saved = await content.saveDraft(
      created.id,
      {
        document: navigation as unknown as Record<string, unknown>,
        note: 'Navigation des pages publiques (données de démonstration)',
        expectedDraftUpdatedAt: draft.updatedAt.toISOString(),
      },
      { actor: REALISTIC_ACTOR, canManageSeo: false },
    );
    await content.publish(
      created.id,
      { expectedDraftUpdatedAt: saved.draft!.updatedAt.toISOString() },
      REALISTIC_ACTOR,
    );
    this.report('catalogue', 'created', 'navigation', 'site', linksOf(navigation));
    return created.id;
  }
}

/** "Paris → Dakar, Dakar → Paris, …": the header links, for the report. */
function linksOf(navigation: Navigation): string {
  const labels = navigation.header.map((link) => link.label);
  return labels.length > 0
    ? `header: ${labels.join(', ')}`
    : `header: none (default: ${DEFAULT_NAVIGATION.header.length} anchors)`;
}

/** Creates, fills and publishes a seat map through the domain service. */
async function publishSeatMap(
  seatMaps: SeatMapService,
  db: PrismaClient,
  existing: {
    id: string;
    versions: Array<{ id: string; status: string; cells: unknown[] }>;
  } | null,
  definition: { code: string; name: string; cells: readonly RealisticSeatCell[] },
  expected: readonly string[],
): Promise<void> {
  if (!existing) {
    await seatMaps.createSeatMap(
      seatMapCreateSchema.parse({ code: definition.code, name: definition.name, active: true }),
      REALISTIC_ACTOR,
    );
  }
  const seatMapId = (await db.seatMap.findUniqueOrThrow({ where: { code: definition.code } })).id;
  let draft = await db.seatMapVersion.findFirst({
    where: { seatMapId, status: 'DRAFT' },
    include: { cells: true },
  });
  if (draft && draft.cells.length > 0) {
    if (!sameList(draft.cells.map(cellSignature).sort(), expected)) {
      throw new RealisticConflict('a draft version with another layout is being edited');
    }
  }
  if (!draft) {
    await seatMaps.createVersion(seatMapId, REALISTIC_ACTOR);
    draft = await db.seatMapVersion.findFirstOrThrow({
      where: { seatMapId, status: 'DRAFT' },
      include: { cells: true },
    });
  }
  if (draft.cells.length === 0) {
    await seatMaps.replaceCells(
      seatMapId,
      draft.id,
      seatMapCellsSchema.parse({ cells: definition.cells }),
      REALISTIC_ACTOR,
    );
  }
  await seatMaps.publish(seatMapId, draft.id, REALISTIC_ACTOR);
}

/** First identity field of an existing vehicle that differs from the demo coach, if any. */
function vehicleDivergence(
  current: {
    name: string | null;
    manufacturer: string;
    model: string;
    modelYear: number | null;
    vin: string | null;
    registrationPlate: string | null;
  },
  vehicle: (typeof REALISTIC_VEHICLES)[number],
): string | null {
  const fields: Array<[string, unknown, unknown]> = [
    ['name', current.name, vehicle.name],
    ['manufacturer', current.manufacturer, vehicle.manufacturer],
    ['model', current.model, vehicle.model],
    ['model year', current.modelYear, null],
    ['VIN', current.vin, null],
    ['registration plate', current.registrationPlate, null],
  ];
  const different = fields.find(([, actual, expected]) => actual !== expected);
  return different ? `existing ${different[0]} differs from the demo coach` : null;
}
