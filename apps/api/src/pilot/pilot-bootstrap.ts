import type { PrismaClient } from '@euroteranga/database';
import { PublicApiError } from '../auth/http/public-api-error.js';
import type { SystemActor } from '../auth/session/auth-principal.js';
import {
  vehicleCreateSchema,
  vehicleSeatMapSchema,
  vehicleStatusSchema,
} from '../fleet/fleet.dto.js';
import type { FleetService } from '../fleet/fleet.service.js';
import {
  checkpointCreateSchema,
  countryCreateSchema,
  replaceWaypointsSchema,
  routeCreateSchema,
  stopCreateSchema,
} from '../network/network.dto.js';
import type { NetworkService } from '../network/network.service.js';
import { fareTableCreateSchema, fareTableFaresSchema } from '../pricing/pricing.dto.js';
import type { PricingService } from '../pricing/pricing.service.js';
import { seatMapCellsSchema, seatMapCreateSchema } from '../seat-maps/seat-map.dto.js';
import type { SeatMapService } from '../seat-maps/seat-map.service.js';
import {
  tripCreateSchema,
  tripFareTableSchema,
  tripSeatMapSchema,
  tripTimetableSchema,
} from '../trips/trip.dto.js';
import type { TripService } from '../trips/trip.service.js';
import {
  PILOT_CHECKPOINTS,
  PILOT_COUNTRIES,
  PILOT_ROUTES,
  PILOT_SEAT_MAP,
  PILOT_SOURCE,
  PILOT_STOPS,
  PILOT_VEHICLES,
  pilotTripSlots,
  zonedTimeToUtc,
  type PilotRoute,
  type PilotTripSlot,
  type PilotWaypoint,
} from './pilot-dataset.js';

export const PILOT_ACTOR: SystemActor = { kind: 'system', source: PILOT_SOURCE };

const HOUR = 3_600_000;
export const MAX_TRIPS_PER_DIRECTION = 8;

export interface PilotBootstrapServices {
  db: PrismaClient;
  network: NetworkService;
  seatMaps: SeatMapService;
  fleet: FleetService;
  pricing: PricingService;
  trips: TripService;
}

export interface PilotBootstrapOptions {
  /** Calendar date (YYYY-MM-DD, UTC) from which departures are planned (J+14, J+28...). */
  anchorDate: string;
  /** Wanted number of future pilot departures per direction (1-8). */
  tripsPerDirection: number;
  /** Read only: report what exists and what would be created. */
  dryRun: boolean;
  /** Clock used to decide which pilot trips are still in the future. */
  now?: Date;
}

export type PilotOutcome =
  'created' | 'completed' | 'existing' | 'planned' | 'skipped' | 'conflict';

export interface PilotReportLine {
  outcome: PilotOutcome;
  entity: string;
  key: string;
  detail?: string;
}

export interface PilotBootstrapReport {
  dryRun: boolean;
  lines: PilotReportLine[];
  /** True when at least one item could not be reconciled with existing data. */
  hasConflicts: boolean;
}

/** An existing record differs from the pilot definition: never overwritten. */
class PilotConflict extends Error {}

type RouteVersionState = { routeVersionId: string; waypointIds: string[] };

interface TripWithTimings {
  id: string;
  reference: string;
  status: string;
  routeVersionId: string;
  vehicleId: string | null;
  seatMapVersionId: string | null;
  fareTableVersionId: string | null;
  plannedDepartureAt: Date | null;
  timings: Array<{
    sequence: number;
    routeWaypointId: string;
    plannedArrivalAt: Date | null;
    plannedDepartureAt: Date | null;
  }>;
}

/**
 * DATA-1: idempotent, resumable bootstrap of the pilot corridor dataset.
 *
 * Every mutation goes through the domain services (same validation, the
 * same transactions and the same audit events as OPS), as the pilot system
 * actor. Each step is atomic. Existing data is reused when it matches the
 * pilot definition, completed when a previous run stopped half-way, and
 * never modified otherwise: a mismatch is reported as a conflict, and the
 * items depending on it are skipped.
 */
export class PilotBootstrap {
  private readonly lines: PilotReportLine[] = [];
  private readonly blocked = new Set<string>();

  constructor(private readonly services: PilotBootstrapServices) {}

  async run(options: PilotBootstrapOptions): Promise<PilotBootstrapReport> {
    if (
      !Number.isInteger(options.tripsPerDirection) ||
      options.tripsPerDirection < 1 ||
      options.tripsPerDirection > MAX_TRIPS_PER_DIRECTION
    ) {
      throw new RangeError(`tripsPerDirection must be 1-${MAX_TRIPS_PER_DIRECTION}`);
    }
    const dry = options.dryRun;
    const countries = await this.step(
      'country',
      PILOT_COUNTRIES,
      (c) => c.iso2,
      (c) => this.ensureCountry(c, dry),
    );
    const places = new Map<string, string>();
    for (const [kind, list] of [
      ['stop', PILOT_STOPS],
      ['checkpoint', PILOT_CHECKPOINTS],
    ] as const) {
      for (const place of list) {
        const id = await this.guarded(kind, place.code, [`country:${place.countryIso2}`], () =>
          this.ensurePlace(kind, place, countries, dry),
        );
        if (id) places.set(`${kind === 'stop' ? 'STOP' : 'CHECKPOINT'}:${place.code}`, id);
      }
    }

    const routes = new Map<string, RouteVersionState>();
    for (const route of PILOT_ROUTES) {
      const dependsOn = route.waypoints.map(
        (w) => `${w.kind === 'STOP' ? 'stop' : 'checkpoint'}:${w.code}`,
      );
      const state = await this.guarded('route', route.code, dependsOn, () =>
        this.ensureRoute(route, places, dry),
      );
      if (state) routes.set(route.code, state);
    }

    const seatMapVersionId = await this.guarded('seat-map', PILOT_SEAT_MAP.code, [], () =>
      this.ensureSeatMap(dry),
    );

    const vehicles = new Map<string, string>();
    for (const vehicle of PILOT_VEHICLES) {
      const id = await this.guarded(
        'vehicle',
        vehicle.code,
        [`country:${vehicle.registrationCountryIso2}`, `seat-map:${PILOT_SEAT_MAP.code}`],
        () => this.ensureVehicle(vehicle, countries, seatMapVersionId ?? null, dry),
      );
      if (id) vehicles.set(vehicle.code, id);
    }

    const fares = new Map<string, string>();
    for (const route of PILOT_ROUTES) {
      const id = await this.guarded(
        'fare-table',
        route.fareTable.code,
        [`route:${route.code}`],
        () => this.ensureFareTable(route, routes.get(route.code) ?? null, dry),
      );
      if (id) fares.set(route.code, id);
    }

    const now = options.now ?? new Date();
    const slots = pilotTripSlots(options.anchorDate, options.tripsPerDirection);
    for (const route of PILOT_ROUTES) {
      await this.ensureTrips(
        route,
        slots.filter((slot) => slot.routeCode === route.code),
        { routes, vehicles, fares, seatMapVersionId: seatMapVersionId ?? null },
        options.tripsPerDirection,
        now,
        dry,
      );
    }

    return {
      dryRun: dry,
      lines: this.lines,
      hasConflicts: this.lines.some((line) => line.outcome === 'conflict'),
    };
  }

  // -- reporting and dependency tracking ------------------------------------

  private report(outcome: PilotOutcome, entity: string, key: string, detail?: string) {
    this.lines.push({ outcome, entity, key, ...(detail ? { detail } : {}) });
  }

  private async step<T, R>(
    entity: string,
    items: readonly T[],
    keyOf: (item: T) => string,
    work: (item: T) => Promise<R | null>,
  ): Promise<Map<string, R>> {
    const results = new Map<string, R>();
    for (const item of items) {
      const result = await this.guarded(entity, keyOf(item), [], () => work(item));
      if (result !== null) results.set(keyOf(item), result);
    }
    return results;
  }

  /** Runs one item unless a dependency is blocked; a conflict blocks the item itself. */
  private async guarded<R>(
    entity: string,
    key: string,
    dependsOn: readonly string[],
    work: () => Promise<R | null>,
  ): Promise<R | null> {
    const missing = dependsOn.find((dependency) => this.blocked.has(dependency));
    if (missing) {
      this.blocked.add(`${entity}:${key}`);
      this.report('skipped', entity, key, `depends on ${missing}`);
      return null;
    }
    try {
      return await work();
    } catch (error) {
      this.blocked.add(`${entity}:${key}`);
      if (error instanceof PilotConflict) {
        this.report('conflict', entity, key, error.message);
        return null;
      }
      if (error instanceof PublicApiError) {
        this.report('conflict', entity, key, `${error.code}: ${error.publicMessage}`);
        return null;
      }
      throw error;
    }
  }

  // -- reference data -------------------------------------------------------

  private async ensureCountry(
    country: (typeof PILOT_COUNTRIES)[number],
    dry: boolean,
  ): Promise<string | null> {
    const { db, network } = this.services;
    const existing = await db.country.findUnique({ where: { iso2: country.iso2 } });
    if (existing) {
      if (existing.iso3 !== country.iso3) {
        throw new PilotConflict(`iso3 is ${existing.iso3}, expected ${country.iso3}`);
      }
      if (!existing.active) throw new PilotConflict('country is inactive');
      // Display names belong to the operator: a different spelling is kept.
      this.report(
        'existing',
        'country',
        country.iso2,
        existing.name === country.name ? undefined : `operator name "${existing.name}" kept`,
      );
      return existing.id;
    }
    if (dry) {
      this.report('planned', 'country', country.iso2);
      return null;
    }
    await network.createCountry(
      countryCreateSchema.parse({ ...country, active: true }),
      PILOT_ACTOR,
    );
    this.report('created', 'country', country.iso2);
    return (await db.country.findUniqueOrThrow({ where: { iso2: country.iso2 } })).id;
  }

  private async ensurePlace(
    kind: 'stop' | 'checkpoint',
    place: (typeof PILOT_STOPS)[number] | (typeof PILOT_CHECKPOINTS)[number],
    countries: Map<string, string>,
    dry: boolean,
  ): Promise<string | null> {
    const { db, network } = this.services;
    const existing =
      kind === 'stop'
        ? await db.stop.findUnique({
            where: { code: place.code },
            include: { country: { select: { iso2: true } } },
          })
        : await db.checkpoint.findUnique({
            where: { code: place.code },
            include: { country: { select: { iso2: true } } },
          });
    if (existing) {
      if (existing.country.iso2 !== place.countryIso2) {
        throw new PilotConflict(`belongs to country ${existing.country.iso2}`);
      }
      // The time zone drives the local timetable of every pilot trip.
      if (existing.timezone !== place.timezone) {
        throw new PilotConflict(`time zone is ${existing.timezone}, expected ${place.timezone}`);
      }
      if ('type' in place && 'type' in existing && existing.type !== place.type) {
        throw new PilotConflict(`type is ${existing.type}, expected ${place.type}`);
      }
      if (!existing.active) throw new PilotConflict(`${kind} is inactive`);
      // Name, locality and position belong to the operator (exact boarding point).
      const described =
        existing.name === place.name &&
        existing.locality === place.locality &&
        Number(existing.latitude) === place.latitude &&
        Number(existing.longitude) === place.longitude;
      this.report(
        'existing',
        kind,
        place.code,
        described ? undefined : 'operator name, locality or position kept',
      );
      return existing.id;
    }
    const countryId = countries.get(place.countryIso2);
    if (dry || !countryId) {
      this.report('planned', kind, place.code);
      return null;
    }
    const { countryIso2: _country, ...fields } = place;
    if (kind === 'stop') {
      await network.createStop(
        stopCreateSchema.parse({ ...fields, countryId, active: true }),
        PILOT_ACTOR,
      );
      this.report('created', kind, place.code);
      return (await db.stop.findUniqueOrThrow({ where: { code: place.code } })).id;
    }
    await network.createCheckpoint(
      checkpointCreateSchema.parse({ ...fields, countryId, active: true }),
      PILOT_ACTOR,
    );
    this.report('created', kind, place.code);
    return (await db.checkpoint.findUniqueOrThrow({ where: { code: place.code } })).id;
  }

  // -- routes ---------------------------------------------------------------

  private async ensureRoute(
    route: PilotRoute,
    places: Map<string, string>,
    dry: boolean,
  ): Promise<RouteVersionState | null> {
    const { db, network } = this.services;
    const expected = route.waypoints.map(waypointSignature);
    const existing = await db.route.findUnique({
      where: { code: route.code },
      include: {
        versions: {
          where: { status: { in: ['PUBLISHED', 'DRAFT'] } },
          include: {
            waypoints: {
              orderBy: { sequence: 'asc' },
              include: { stop: { select: { code: true } }, checkpoint: { select: { code: true } } },
            },
          },
        },
      },
    });
    const signatureOf = (version: NonNullable<typeof existing>['versions'][number]) =>
      version.waypoints.map((waypoint) =>
        waypoint.stop
          ? `STOP:${waypoint.stop.code}:${waypoint.boardingAllowed}:${waypoint.alightingAllowed}`
          : `CHECKPOINT:${waypoint.checkpoint?.code}`,
      );
    const published = existing?.versions.find((version) => version.status === 'PUBLISHED');
    if (published) {
      if (!sameList(signatureOf(published), expected)) {
        throw new PilotConflict('its published version differs from the pilot corridor');
      }
      this.report('existing', 'route', route.code, `version ${published.version}`);
      return {
        routeVersionId: published.id,
        waypointIds: published.waypoints.map((waypoint) => waypoint.id),
      };
    }
    if (existing && !existing.active) throw new PilotConflict('route is inactive');
    if (dry || route.waypoints.some((waypoint) => !places.has(placeKey(waypoint)))) {
      this.report('planned', 'route', route.code);
      return null;
    }

    const routeId =
      existing?.id ??
      (
        await network.createRoute(
          routeCreateSchema.parse({ code: route.code, name: route.name, active: true }),
          PILOT_ACTOR,
        )
      ).id;
    const draft = existing?.versions.find((version) => version.status === 'DRAFT');
    if (draft && draft.waypoints.length > 0 && !sameList(signatureOf(draft), expected)) {
      throw new PilotConflict('a draft version with other waypoints is being edited');
    }
    const versionId = draft?.id ?? (await network.createRouteVersion(routeId, PILOT_ACTOR)).id;
    if (!draft || draft.waypoints.length === 0) {
      await network.replaceWaypoints(
        routeId,
        versionId,
        replaceWaypointsSchema.parse({
          waypoints: route.waypoints.map((waypoint) =>
            waypoint.kind === 'STOP'
              ? {
                  kind: 'STOP',
                  stopId: places.get(placeKey(waypoint)),
                  boardingAllowed: waypoint.boardingAllowed,
                  alightingAllowed: waypoint.alightingAllowed,
                }
              : { kind: 'CHECKPOINT', checkpointId: places.get(placeKey(waypoint)) },
          ),
        }),
        PILOT_ACTOR,
      );
    }
    await network.publishRouteVersion(routeId, versionId, PILOT_ACTOR);
    this.report(existing ? 'completed' : 'created', 'route', route.code);
    const waypoints = await db.routeWaypoint.findMany({
      where: { routeVersionId: versionId },
      orderBy: { sequence: 'asc' },
      select: { id: true },
    });
    return { routeVersionId: versionId, waypointIds: waypoints.map((waypoint) => waypoint.id) };
  }

  // -- seat map -------------------------------------------------------------

  private async ensureSeatMap(dry: boolean): Promise<string | null> {
    const { db, seatMaps } = this.services;
    const expected = PILOT_SEAT_MAP.cells.map(cellSignature).sort();
    const existing = await db.seatMap.findUnique({
      where: { code: PILOT_SEAT_MAP.code },
      include: {
        versions: { where: { status: { in: ['PUBLISHED', 'DRAFT'] } }, include: { cells: true } },
      },
    });
    const published = existing?.versions.find((version) => version.status === 'PUBLISHED');
    if (published) {
      if (!sameList(published.cells.map(cellSignature).sort(), expected)) {
        throw new PilotConflict('its published version differs from the pilot layout');
      }
      this.report('existing', 'seat-map', PILOT_SEAT_MAP.code, `version ${published.version}`);
      return published.id;
    }
    if (existing && !existing.active) throw new PilotConflict('seat map is inactive');
    if (dry) {
      this.report('planned', 'seat-map', PILOT_SEAT_MAP.code);
      return null;
    }
    if (!existing) {
      await seatMaps.createSeatMap(
        seatMapCreateSchema.parse({
          code: PILOT_SEAT_MAP.code,
          name: PILOT_SEAT_MAP.name,
          active: true,
        }),
        PILOT_ACTOR,
      );
    }
    const seatMapId = (await db.seatMap.findUniqueOrThrow({ where: { code: PILOT_SEAT_MAP.code } }))
      .id;
    let draft = existing?.versions.find((version) => version.status === 'DRAFT');
    if (
      draft &&
      draft.cells.length > 0 &&
      !sameList(draft.cells.map(cellSignature).sort(), expected)
    ) {
      throw new PilotConflict('a draft version with another layout is being edited');
    }
    if (!draft) {
      await seatMaps.createVersion(seatMapId, PILOT_ACTOR);
      draft = await db.seatMapVersion.findFirstOrThrow({
        where: { seatMapId, status: 'DRAFT' },
        include: { cells: true },
      });
    }
    if (draft.cells.length === 0) {
      await seatMaps.replaceCells(
        seatMapId,
        draft.id,
        seatMapCellsSchema.parse({ cells: PILOT_SEAT_MAP.cells }),
        PILOT_ACTOR,
      );
    }
    await seatMaps.publish(seatMapId, draft.id, PILOT_ACTOR);
    this.report(existing ? 'completed' : 'created', 'seat-map', PILOT_SEAT_MAP.code);
    return draft.id;
  }

  // -- vehicles -------------------------------------------------------------

  private async ensureVehicle(
    vehicle: (typeof PILOT_VEHICLES)[number],
    countries: Map<string, string>,
    seatMapVersionId: string | null,
    dry: boolean,
  ): Promise<string | null> {
    const { db, fleet } = this.services;
    let current = await db.vehicle.findUnique({
      where: { code: vehicle.code },
      include: { registrationCountry: { select: { iso2: true } } },
    });
    if (current) {
      // Fail-closed: an existing vehicle is the pilot coach only if every
      // identity field is the pilot one. The bootstrap writes them all at
      // creation, so a difference means operator data: never overwritten.
      const divergence = vehicleDivergence(current, vehicle);
      if (divergence) throw new PilotConflict(divergence);
      if (current.status === 'RETIRED' || current.status === 'OUT_OF_SERVICE') {
        throw new PilotConflict(`vehicle is ${current.status}`);
      }
      if (
        current.seatMapVersionId &&
        seatMapVersionId &&
        current.seatMapVersionId !== seatMapVersionId
      ) {
        throw new PilotConflict('vehicle uses another seat map');
      }
    }
    const complete = current?.status === 'ACTIVE' && current.seatMapVersionId === seatMapVersionId;
    if (current && complete) {
      this.report('existing', 'vehicle', vehicle.code);
      return current.id;
    }
    const countryId = countries.get(vehicle.registrationCountryIso2);
    if (dry || !seatMapVersionId || !countryId) {
      this.report('planned', 'vehicle', vehicle.code);
      return null;
    }
    const createdNow = !current;
    if (!current) {
      const { registrationCountryIso2: _country, ...fields } = vehicle;
      await fleet.createVehicle(
        vehicleCreateSchema.parse({ ...fields, registrationCountryId: countryId }),
        PILOT_ACTOR,
      );
      current = await db.vehicle.findUniqueOrThrow({
        where: { code: vehicle.code },
        include: { registrationCountry: { select: { iso2: true } } },
      });
    }
    if (current.seatMapVersionId !== seatMapVersionId) {
      await fleet.assignSeatMap(
        current.id,
        vehicleSeatMapSchema.parse({ seatMapVersionId, expectedSeatMapVersionId: null }),
        PILOT_ACTOR,
      );
    }
    if (current.status === 'PLANNED') {
      await fleet.changeStatus(
        current.id,
        vehicleStatusSchema.parse({
          status: 'ACTIVE',
          reason: 'Mise en service pilote (bootstrap des données pilotes)',
          expectedStatus: 'PLANNED',
        }),
        PILOT_ACTOR,
      );
    }
    this.report(createdNow ? 'created' : 'completed', 'vehicle', vehicle.code);
    return current.id;
  }

  // -- pricing --------------------------------------------------------------

  private async ensureFareTable(
    route: PilotRoute,
    routeVersion: RouteVersionState | null,
    dry: boolean,
  ): Promise<string | null> {
    const { db, pricing } = this.services;
    const code = route.fareTable.code;
    const existing = await db.fareTable.findUnique({
      where: { code },
      include: {
        route: { select: { code: true } },
        versions: { where: { status: { in: ['PUBLISHED', 'DRAFT'] } }, include: { entries: true } },
      },
    });
    if (existing) {
      if (existing.route.code !== route.code) throw new PilotConflict('prices another route');
      if (
        existing.currencyCode !== route.fareTable.currencyCode ||
        existing.currencyMinorUnit !== route.fareTable.currencyMinorUnit
      ) {
        throw new PilotConflict('uses another currency');
      }
      if (!existing.active) throw new PilotConflict('fare table is inactive');
    }
    if (!routeVersion) {
      this.report('planned', 'fare-table', code);
      return null;
    }
    const origin = routeVersion.waypointIds[0]!;
    const destination = routeVersion.waypointIds.at(-1)!;
    const expected = [`${origin}>${destination}=${route.fareAmountMinor}`];
    const signatureOf = (
      entries: Array<{
        originRouteWaypointId: string;
        destinationRouteWaypointId: string;
        amountMinor: number;
      }>,
    ) =>
      entries
        .map(
          (entry) =>
            `${entry.originRouteWaypointId}>${entry.destinationRouteWaypointId}=${entry.amountMinor}`,
        )
        .sort();

    const published = existing?.versions.find(
      (version) =>
        version.status === 'PUBLISHED' && version.routeVersionId === routeVersion.routeVersionId,
    );
    if (published) {
      if (!sameList(signatureOf(published.entries), expected)) {
        throw new PilotConflict('its published fares differ from the pilot fare');
      }
      this.report('existing', 'fare-table', code, `version ${published.version}`);
      return published.id;
    }
    if (existing?.versions.some((version) => version.status === 'PUBLISHED')) {
      throw new PilotConflict('it is published for another route version');
    }
    if (dry) {
      this.report('planned', 'fare-table', code);
      return null;
    }
    if (!existing) {
      await pricing.createFareTable(
        fareTableCreateSchema.parse({
          code,
          name: route.fareTable.name,
          routeId: (await db.route.findUniqueOrThrow({ where: { code: route.code } })).id,
          currencyCode: route.fareTable.currencyCode,
          currencyMinorUnit: route.fareTable.currencyMinorUnit,
          active: true,
        }),
        PILOT_ACTOR,
      );
    }
    const fareTableId = (await db.fareTable.findUniqueOrThrow({ where: { code } })).id;
    let draft = existing?.versions.find((version) => version.status === 'DRAFT');
    if (draft && draft.routeVersionId !== routeVersion.routeVersionId) {
      throw new PilotConflict('a draft for another route version is being edited');
    }
    if (draft && draft.entries.length > 0 && !sameList(signatureOf(draft.entries), expected)) {
      throw new PilotConflict('a draft with other fares is being edited');
    }
    if (!draft) {
      await pricing.createVersion(fareTableId, routeVersion.routeVersionId, PILOT_ACTOR);
      draft = await db.fareTableVersion.findFirstOrThrow({
        where: { fareTableId, status: 'DRAFT' },
        include: { entries: true },
      });
    }
    if (draft.entries.length === 0) {
      await pricing.replaceFares(
        fareTableId,
        draft.id,
        fareTableFaresSchema.parse({
          fares: [
            {
              originRouteWaypointId: origin,
              destinationRouteWaypointId: destination,
              amountMinor: route.fareAmountMinor,
            },
          ],
        }),
        PILOT_ACTOR,
      );
    }
    await pricing.publish(fareTableId, draft.id, PILOT_ACTOR);
    this.report(existing ? 'completed' : 'created', 'fare-table', code);
    return draft.id;
  }

  // -- trips ----------------------------------------------------------------

  private async ensureTrips(
    route: PilotRoute,
    slots: readonly PilotTripSlot[],
    context: {
      routes: Map<string, RouteVersionState>;
      vehicles: Map<string, string>;
      fares: Map<string, string>;
      seatMapVersionId: string | null;
    },
    wanted: number,
    now: Date,
    dry: boolean,
  ): Promise<void> {
    const { db } = this.services;
    const routeVersion = context.routes.get(route.code);
    const fareTableVersionId = context.fares.get(route.code);
    const directionDependency = !routeVersion
      ? `route:${route.code}`
      : !fareTableVersionId
        ? `fare-table:${route.fareTable.code}`
        : !context.seatMapVersionId
          ? `seat-map:${PILOT_SEAT_MAP.code}`
          : null;

    // Every upcoming pilot trip of this direction must still be exactly the
    // pilot definition before it is counted. One divergent trip blocks the
    // direction: nothing is added next to operator changes.
    let upcoming = 0;
    if (!directionDependency) {
      const pilotVehicles = new Set(context.vehicles.values());
      const candidates = await db.trip.findMany({
        where: {
          reference: { startsWith: `ET-PILOT-${route.direction}-` },
          OR: [{ status: 'SCHEDULED', plannedDepartureAt: { gt: now } }, { status: 'DRAFT' }],
        },
        include: { timings: { orderBy: { sequence: 'asc' } } },
        orderBy: { reference: 'asc' },
      });
      const slotReferences = new Set(slots.map((slot) => slot.reference));
      let divergent = false;
      for (const trip of candidates) {
        // A draft of one of this run's slots is handled (completed or refused) below.
        if (trip.status === 'DRAFT' && slotReferences.has(trip.reference)) continue;
        const divergence =
          trip.status === 'DRAFT'
            ? 'draft pilot trip from another run: complete or cancel it in OPS'
            : tripDivergence(route, trip, {
                routeVersion: routeVersion!,
                seatMapVersionId: context.seatMapVersionId!,
                fareTableVersionId: fareTableVersionId!,
                vehicleIds: pilotVehicles,
              });
        if (divergence) {
          divergent = true;
          this.report('conflict', 'trip', trip.reference, divergence);
        } else {
          upcoming += 1;
        }
      }
      if (divergent) {
        this.blocked.add(`trips:${route.code}`);
        this.report('skipped', 'trips', route.code, 'depends on the conflicting pilot trips');
        return;
      }
    }

    const missing = Math.max(0, wanted - upcoming);
    if (missing === 0) {
      this.report('existing', 'trips', route.code, `${upcoming} upcoming pilot departures`);
    }
    let remaining = missing;
    for (const slot of slots) {
      if (remaining === 0) break;
      const vehicleId = context.vehicles.get(slot.vehicleCode);
      const dependency = directionDependency ?? (!vehicleId ? `vehicle:${slot.vehicleCode}` : null);
      if (this.departureOf(route, slot) <= now) {
        this.report('skipped', 'trip', slot.reference, 'departure is not in the future');
        continue;
      }
      const existing = await db.trip.findUnique({
        where: { reference: slot.reference },
        include: { timings: { orderBy: { sequence: 'asc' } } },
      });
      if (existing?.status === 'SCHEDULED') {
        // Already verified and counted above, or in the past.
        this.report('existing', 'trip', slot.reference);
        continue;
      }
      if (existing && existing.status !== 'DRAFT') {
        this.report('skipped', 'trip', slot.reference, `trip is ${existing.status}`);
        continue;
      }
      if (dependency || dry) {
        this.report(
          dry ? 'planned' : 'skipped',
          'trip',
          slot.reference,
          dependency ? `depends on ${dependency}` : undefined,
        );
        remaining -= 1;
        continue;
      }
      const result = await this.guarded('trip', slot.reference, [], () =>
        this.ensureTrip(route, slot, existing, {
          routeVersion: routeVersion!,
          vehicleId: vehicleId!,
          seatMapVersionId: context.seatMapVersionId!,
          fareTableVersionId: fareTableVersionId!,
        }),
      );
      if (result) remaining -= 1;
    }
  }

  /** UTC departure of a slot: its local departure time at the first stop. */
  private departureOf(route: PilotRoute, slot: PilotTripSlot): Date {
    const firstStop = PILOT_STOPS.find((stop) => stop.code === route.waypoints[0]!.code)!;
    return zonedTimeToUtc(slot.departureDate, route.departureLocalTime, firstStop.timezone);
  }

  private async ensureTrip(
    route: PilotRoute,
    slot: PilotTripSlot,
    existing: TripWithTimings | null,
    context: {
      routeVersion: RouteVersionState;
      vehicleId: string;
      seatMapVersionId: string;
      fareTableVersionId: string;
    },
  ): Promise<string> {
    const { db, trips } = this.services;
    const departure = this.departureOf(route, slot);
    const at = (hours: number | null) =>
      hours === null ? null : new Date(departure.getTime() + hours * HOUR).toISOString();
    const timings = route.timings.map((timing, index) => ({
      routeWaypointId: context.routeVersion.waypointIds[index],
      plannedArrivalAt: at(timing.arrivalHour),
      plannedDepartureAt: at(timing.departureHour),
    }));
    const arrival = new Date(at(route.timings.at(-1)!.arrivalHour)!);
    const existingId = existing?.id ?? null;

    // A draft of this slot is completed only when everything already set on
    // it is the pilot value; anything else is operator data and is refused.
    if (existing) {
      const draftDivergence = draftDivergenceOf(existing, {
        routeVersionId: context.routeVersion.routeVersionId,
        vehicleId: context.vehicleId,
        seatMapVersionId: context.seatMapVersionId,
        fareTableVersionId: context.fareTableVersionId,
        timings: route.timings.map((timing) => ({
          arrival: at(timing.arrivalHour),
          departure: at(timing.departureHour),
        })),
      });
      if (draftDivergence) throw new PilotConflict(draftDivergence);
    }

    // A vehicle already serving an overlapping trip (e.g. from an earlier run
    // anchored on another date) is reported before anything is written.
    const conflict = await db.trip.findFirst({
      where: {
        vehicleId: context.vehicleId,
        status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
        plannedDepartureAt: { lt: arrival },
        plannedArrivalAt: { gt: departure },
        ...(existingId ? { id: { not: existingId } } : {}),
      },
      select: { reference: true },
    });
    if (conflict)
      throw new PilotConflict(`vehicle ${slot.vehicleCode} serves ${conflict.reference}`);

    const id =
      existingId ??
      (
        await trips.createTrip(
          tripCreateSchema.parse({
            reference: slot.reference,
            routeVersionId: context.routeVersion.routeVersionId,
            vehicleId: context.vehicleId,
          }),
          PILOT_ACTOR,
        )
      ).id;
    const draft = await db.trip.findUniqueOrThrow({ where: { id } });
    if (!existing || existing.timings.length === 0) {
      await trips.replaceTimetable(id, tripTimetableSchema.parse({ timings }), PILOT_ACTOR);
    }
    if (draft.seatMapVersionId !== context.seatMapVersionId) {
      await trips.assignSeatMap(
        id,
        tripSeatMapSchema.parse({ seatMapVersionId: context.seatMapVersionId }),
        PILOT_ACTOR,
      );
    }
    if (draft.fareTableVersionId !== context.fareTableVersionId) {
      await trips.assignFareTable(
        id,
        tripFareTableSchema.parse({ fareTableVersionId: context.fareTableVersionId }),
        PILOT_ACTOR,
      );
    }
    await trips.schedule(id, PILOT_ACTOR);
    this.report(
      existingId ? 'completed' : 'created',
      'trip',
      slot.reference,
      `${slot.vehicleCode}, ${departure.toISOString()}`,
    );
    return id;
  }
}

function placeKey(waypoint: PilotWaypoint): string {
  return `${waypoint.kind}:${waypoint.code}`;
}

function waypointSignature(waypoint: PilotWaypoint): string {
  return waypoint.kind === 'STOP'
    ? `STOP:${waypoint.code}:${waypoint.boardingAllowed}:${waypoint.alightingAllowed}`
    : `CHECKPOINT:${waypoint.code}`;
}

function cellSignature(cell: {
  deck: number;
  row: number;
  column: number;
  kind: string;
  seatLabel?: string | null;
}): string {
  return `${cell.deck}:${cell.row}:${cell.column}:${cell.kind}:${cell.seatLabel ?? ''}`;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** First identity field of an existing vehicle that differs from the pilot coach, if any. */
function vehicleDivergence(
  current: {
    name: string | null;
    manufacturer: string;
    model: string;
    modelYear: number | null;
    vin: string | null;
    registrationPlate: string | null;
    registrationCountry: { iso2: string } | null;
  },
  pilot: (typeof PILOT_VEHICLES)[number],
): string | null {
  const fields: Array<[string, unknown, unknown]> = [
    ['name', current.name, pilot.name],
    ['manufacturer', current.manufacturer, pilot.manufacturer],
    ['model', current.model, pilot.model],
    ['model year', current.modelYear, pilot.modelYear],
    ['VIN', current.vin, null],
    ['registration plate', current.registrationPlate, pilot.registrationPlate],
    [
      'registration country',
      current.registrationCountry?.iso2 ?? null,
      pilot.registrationCountryIso2,
    ],
  ];
  const different = fields.find(([, actual, expected]) => actual !== expected);
  return different ? `existing ${different[0]} differs from the pilot coach` : null;
}

const time = (value: Date | string | null) => (value === null ? null : new Date(value).getTime());

/**
 * Why a SCHEDULED pilot trip is not (or no longer) exactly the pilot
 * definition: route version, coach, seat map, pricing and a timetable with
 * the pilot shape from its own departure. Null when it matches.
 */
function tripDivergence(
  route: PilotRoute,
  trip: TripWithTimings,
  expected: {
    routeVersion: RouteVersionState;
    seatMapVersionId: string;
    fareTableVersionId: string;
    vehicleIds: ReadonlySet<string>;
  },
): string | null {
  if (trip.routeVersionId !== expected.routeVersion.routeVersionId) {
    return 'uses another route version';
  }
  if (!trip.vehicleId || !expected.vehicleIds.has(trip.vehicleId)) {
    return 'is not served by a pilot coach';
  }
  if (trip.seatMapVersionId !== expected.seatMapVersionId) return 'uses another seat map';
  if (trip.fareTableVersionId !== expected.fareTableVersionId) return 'uses another fare table';
  const departure = time(trip.plannedDepartureAt);
  // The reference names the local departure date: ET-PILOT-<direction>-YYYYMMDD.
  const date = /-(\d{4})(\d{2})(\d{2})$/.exec(trip.reference);
  const firstStop = PILOT_STOPS.find((stop) => stop.code === route.waypoints[0]!.code)!;
  if (
    !date ||
    departure !==
      zonedTimeToUtc(
        `${date[1]}-${date[2]}-${date[3]}`,
        route.departureLocalTime,
        firstStop.timezone,
      ).getTime()
  ) {
    return 'departure does not match its reference date and pilot time';
  }
  if (departure === null || trip.timings.length !== route.timings.length) {
    return 'timetable differs from the pilot timetable';
  }
  const offset = (hours: number | null) => (hours === null ? null : departure + hours * HOUR);
  const same = route.timings.every((timing, index) => {
    const actual = trip.timings[index]!;
    return (
      actual.routeWaypointId === expected.routeVersion.waypointIds[index] &&
      time(actual.plannedArrivalAt) === offset(timing.arrivalHour) &&
      time(actual.plannedDepartureAt) === offset(timing.departureHour)
    );
  });
  return same ? null : 'timetable differs from the pilot timetable';
}

/** Why a DRAFT trip of a slot cannot be completed: a value already set is not the pilot one. */
function draftDivergenceOf(
  trip: TripWithTimings,
  expected: {
    routeVersionId: string;
    vehicleId: string;
    seatMapVersionId: string;
    fareTableVersionId: string;
    timings: Array<{ arrival: string | null; departure: string | null }>;
  },
): string | null {
  if (trip.routeVersionId !== expected.routeVersionId) return 'draft uses another route version';
  if (trip.vehicleId !== expected.vehicleId) return 'draft uses another vehicle';
  if (trip.seatMapVersionId !== null && trip.seatMapVersionId !== expected.seatMapVersionId) {
    return 'draft uses another seat map';
  }
  if (trip.fareTableVersionId !== null && trip.fareTableVersionId !== expected.fareTableVersionId) {
    return 'draft uses another fare table';
  }
  if (trip.timings.length === 0) return null;
  const same =
    trip.timings.length === expected.timings.length &&
    expected.timings.every(
      (timing, index) =>
        time(trip.timings[index]!.plannedArrivalAt) === time(timing.arrival) &&
        time(trip.timings[index]!.plannedDepartureAt) === time(timing.departure),
    );
  return same ? null : 'draft timetable differs from the pilot timetable';
}
