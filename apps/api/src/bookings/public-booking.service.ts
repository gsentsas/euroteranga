import { Prisma } from '@euroteranga/database';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { publicMediaSelect, publicMediaView } from '../media/public-media-view.js';
import { findTripFare } from '../pricing/fare-resolution.service.js';
import { BOOKING_CONFIG, type BookingConfig } from './booking.config.js';
import { encodeSearchCursor, type BookingSearchQuery } from './booking.dto.js';
import { BookingErrors } from './booking.errors.js';
import { occupiedSeatCells, readBookableTrip } from './booking-inventory.js';
import { publicStopSelect } from './booking-views.js';

interface SearchRow {
  trip_id: string;
  trip_reference: string;
  route_code: string;
  route_name: string;
  origin_id: string;
  destination_id: string;
  origin_stop_id: string;
  destination_stop_id: string;
  departure_at: Date;
  arrival_at: Date;
  amount_minor: number;
  currency_code: string;
  currency_minor_unit: number;
  seat_count: number;
  occupied: number;
  vehicle_id: string | null;
}

/**
 * Public, unauthenticated reads: stops, bookable trips for an
 * origin/destination and seat availability. They return only what a traveller
 * needs to choose a trip and a seat (only the assigned coach's public main
 * image is included for presentation; no vehicle identifiers or catalogue).
 */
@Injectable()
export class PublicBookingService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(BOOKING_CONFIG) private readonly config: BookingConfig,
  ) {}

  /**
   * UI-PUBLIC-2: the planned itinerary of a bookable trip (same visibility
   * as the search: scheduled, not departed, seat map set) — every stop and
   * border post of its route version with the trip's frozen times, and the
   * assigned vehicle's public facts while it is active.
   */
  async itinerary(tripId: string) {
    const trip = await this.database.client.trip.findFirst({
      where: {
        id: tripId,
        status: 'SCHEDULED',
        plannedDepartureAt: { gt: new Date() },
        seatMapVersionId: { not: null },
      },
      select: {
        id: true,
        reference: true,
        routeVersion: {
          select: {
            route: { select: { code: true, name: true } },
            waypoints: {
              orderBy: { sequence: 'asc' },
              select: {
                id: true,
                sequence: true,
                boardingAllowed: true,
                alightingAllowed: true,
                stop: { select: publicStopSelect },
                checkpoint: {
                  select: {
                    name: true,
                    type: true,
                    locality: true,
                    timezone: true,
                    country: { select: { iso2: true, name: true } },
                  },
                },
              },
            },
          },
        },
        timings: {
          select: { routeWaypointId: true, plannedArrivalAt: true, plannedDepartureAt: true },
        },
        vehicle: {
          select: {
            code: true,
            name: true,
            manufacturer: true,
            model: true,
            modelYear: true,
            status: true,
            role: true,
            amenities: true,
          },
        },
      },
    });
    if (!trip) throw BookingErrors.tripNotBookable();
    const timings = new Map(trip.timings.map((timing) => [timing.routeWaypointId, timing]));
    const { status: vehicleStatus, role: vehicleRole, ...vehicle } = trip.vehicle ?? {
      status: null,
      role: null,
    };
    return {
      tripId: trip.id,
      tripReference: trip.reference,
      route: trip.routeVersion.route,
      vehicle:
        trip.vehicle && vehicleStatus === 'ACTIVE' && vehicleRole !== 'CARGO_SUPPORT'
          ? vehicle
          : null,
      // Technical checkpoints (fuel, rest, crew change) stay internal: only
      // stops, borders and crossings are public.
      waypoints: trip.routeVersion.waypoints
        .filter((waypoint) => waypoint.checkpoint?.type !== 'TECHNICAL')
        .map((waypoint) => {
          const timing = timings.get(waypoint.id);
          const place = waypoint.stop ?? waypoint.checkpoint;
          return {
            routeWaypointId: waypoint.id,
            sequence: waypoint.sequence,
            kind: waypoint.stop ? ('STOP' as const) : ('CHECKPOINT' as const),
            code: waypoint.stop?.code ?? null,
            name: place?.name ?? null,
            locality: place?.locality ?? null,
            timezone: place?.timezone ?? null,
            country: place?.country ?? null,
            checkpointType: waypoint.checkpoint?.type ?? null,
            boardingAllowed: waypoint.boardingAllowed,
            alightingAllowed: waypoint.alightingAllowed,
            plannedArrivalAt: timing?.plannedArrivalAt ?? null,
            plannedDepartureAt: timing?.plannedDepartureAt ?? null,
          };
        }),
    };
  }

  /** Active stops of active countries, keyset by id, optional text search. */
  async stops(query: { query?: string | undefined; limit: number; cursor?: string | undefined }) {
    const term = query.query;
    const rows = await this.database.client.stop.findMany({
      take: query.limit + 1,
      where: {
        active: true,
        country: { active: true },
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { code: { contains: term, mode: 'insensitive' } },
                { locality: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'desc' },
      select: publicStopSelect,
    });
    const items = rows.slice(0, query.limit);
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Bookable journeys: SCHEDULED trips not yet departed, with a seat map and
   * pricing, and every waypoint pair (origin stop allowing boarding, before a
   * destination stop allowing alighting) that has an exact fare. A stop can
   * appear several times in a route version: each valid waypoint pair is its
   * own, unambiguous result (identified by its route waypoint ids).
   */
  async search(query: BookingSearchQuery) {
    const filters: Prisma.Sql[] = [];
    if (query.departureFrom)
      filters.push(Prisma.sql`AND ot."planned_departure_at" >= ${query.departureFrom}`);
    if (query.departureTo)
      filters.push(Prisma.sql`AND ot."planned_departure_at" < ${query.departureTo}`);
    const cursor = query.cursor
      ? Prisma.sql`AND (c."departure_at", c."trip_id", c."origin_id", c."destination_id") >
          (${query.cursor.departureAt}, ${query.cursor.tripId}::uuid,
           ${query.cursor.originRouteWaypointId}::uuid, ${query.cursor.destinationRouteWaypointId}::uuid)`
      : Prisma.empty;
    const minSeats = query.minAvailableSeats
      ? Prisma.sql`AND c."seat_count" - c."occupied" >= ${query.minAvailableSeats}::int`
      : Prisma.empty;

    const rows = await this.database.client.$queryRaw<SearchRow[]>`
      WITH candidates AS (
        SELECT
          t."id" AS "trip_id", t."reference" AS "trip_reference",
          t."vehicle_id",
          r."code" AS "route_code", r."name" AS "route_name",
          o."id" AS "origin_id", d."id" AS "destination_id",
          o."stop_id" AS "origin_stop_id", d."stop_id" AS "destination_stop_id",
          ot."planned_departure_at" AS "departure_at", dt."planned_arrival_at" AS "arrival_at",
          fe."amount_minor", ft."currency_code", ft."currency_minor_unit",
          (
            SELECT count(*) FROM "seat_map_cell" sc
            WHERE sc."seat_map_version_id" = t."seat_map_version_id" AND sc."kind" = 'SEAT'
          )::int AS "seat_count",
          (
            SELECT count(DISTINCT l."seat_map_cell_id")
            FROM "seat_inventory_lock" l
            JOIN "booking_seat" bs ON bs."id" = l."booking_seat_id"
            JOIN "booking" b ON b."id" = bs."booking_id"
            WHERE l."trip_id" = t."id"
              AND l."segment_sequence" >= o."sequence"
              AND l."segment_sequence" < d."sequence"
              AND b."cancelled_at" IS NULL
              AND (b."confirmed_at" IS NOT NULL OR b."hold_expires_at" > now())
          )::int AS "occupied"
        FROM "trip" t
        JOIN "route_version" rv ON rv."id" = t."route_version_id"
        JOIN "route" r ON r."id" = rv."route_id"
        JOIN "route_waypoint" o
          ON o."route_version_id" = t."route_version_id"
          AND o."stop_id" = ${query.originStopId}::uuid
          AND o."boarding_allowed"
        JOIN "route_waypoint" d
          ON d."route_version_id" = t."route_version_id"
          AND d."stop_id" = ${query.destinationStopId}::uuid
          AND d."alighting_allowed"
          AND d."sequence" > o."sequence"
        JOIN "fare_entry" fe
          ON fe."fare_table_version_id" = t."fare_table_version_id"
          AND fe."origin_route_waypoint_id" = o."id"
          AND fe."destination_route_waypoint_id" = d."id"
        JOIN "fare_table_version" fv ON fv."id" = t."fare_table_version_id"
        JOIN "fare_table" ft ON ft."id" = fv."fare_table_id"
        JOIN "trip_waypoint_timing" ot ON ot."trip_id" = t."id" AND ot."route_waypoint_id" = o."id"
        JOIN "trip_waypoint_timing" dt ON dt."trip_id" = t."id" AND dt."route_waypoint_id" = d."id"
        WHERE t."status" = 'SCHEDULED'
          AND t."planned_departure_at" > now()
          AND t."seat_map_version_id" IS NOT NULL
          AND ot."planned_departure_at" IS NOT NULL
          ${filters.length > 0 ? Prisma.join(filters, ' ') : Prisma.empty}
      )
      SELECT c.* FROM candidates c
      WHERE TRUE ${cursor} ${minSeats}
      ORDER BY c."departure_at", c."trip_id", c."origin_id", c."destination_id"
      LIMIT ${query.limit + 1}::int
    `;
    const page = rows.slice(0, query.limit);
    const stopIds = [
      ...new Set(page.flatMap((row) => [row.origin_stop_id, row.destination_stop_id])),
    ];
    const stops = new Map(
      (
        await this.database.client.stop.findMany({
          where: { id: { in: stopIds } },
          select: publicStopSelect,
        })
      ).map((stop) => [stop.id, stop]),
    );
    const vehicleIds = [
      ...new Set(page.flatMap((row) => (row.vehicle_id ? [row.vehicle_id] : []))),
    ];
    const vehicleMedia = new Map(
      (
        await this.database.client.vehicle.findMany({
          where: {
            id: { in: vehicleIds },
            status: 'ACTIVE',
            role: { in: ['PASSENGER_COACH', 'MIXED'] },
          },
          select: { id: true, primaryMedia: { select: publicMediaSelect } },
        })
      ).map((vehicle) => [vehicle.id, publicMediaView(vehicle.primaryMedia)]),
    );
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        tripId: row.trip_id,
        tripReference: row.trip_reference,
        route: { code: row.route_code, name: row.route_name },
        origin: {
          routeWaypointId: row.origin_id,
          stop: stops.get(row.origin_stop_id) ?? null,
          plannedDepartureAt: row.departure_at,
        },
        destination: {
          routeWaypointId: row.destination_id,
          stop: stops.get(row.destination_stop_id) ?? null,
          plannedArrivalAt: row.arrival_at,
        },
        fare: {
          amountMinor: row.amount_minor,
          currencyCode: row.currency_code,
          currencyMinorUnit: row.currency_minor_unit,
        },
        seatCount: row.seat_count,
        availableSeatCount: Math.max(0, row.seat_count - row.occupied),
        vehiclePrimaryMedia: row.vehicle_id ? (vehicleMedia.get(row.vehicle_id) ?? null) : null,
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeSearchCursor({
              departureAt: last.departure_at,
              tripId: last.trip_id,
              originRouteWaypointId: last.origin_id,
              destinationRouteWaypointId: last.destination_id,
            })
          : null,
    };
  }

  /**
   * Physical layout of the trip's historical seat map (PR-07) with, for each
   * seat, whether it is free on every segment of the requested journey, and
   * the exact fare of that journey (PR-08 historical pricing).
   */
  async availability(
    tripId: string,
    originRouteWaypointId: string,
    destinationRouteWaypointId: string,
  ) {
    const client = this.database.client;
    const trip = await readBookableTrip(client, tripId, this.config.holdTtlSeconds, false);
    const fare = await findTripFare(
      client,
      trip,
      originRouteWaypointId,
      destinationRouteWaypointId,
    );
    if (!fare.ok) {
      if (fare.reason === 'PRICING_NOT_CONFIGURED') throw BookingErrors.pricingNotConfigured();
      if (fare.reason === 'WAYPOINT_INVALID') throw BookingErrors.odInvalid();
      throw BookingErrors.fareNotConfigured();
    }
    const [cells, occupied, waypoints, timings] = await Promise.all([
      client.seatMapCell.findMany({
        where: { seatMapVersionId: trip.seatMapVersionId },
        orderBy: [{ deck: 'asc' }, { row: 'asc' }, { column: 'asc' }],
        select: { id: true, deck: true, row: true, column: true, kind: true, seatLabel: true },
      }),
      occupiedSeatCells(client, trip.id, fare.originSequence, fare.destinationSequence),
      client.routeWaypoint.findMany({
        where: { id: { in: [originRouteWaypointId, destinationRouteWaypointId] } },
        select: { id: true, stop: { select: publicStopSelect } },
      }),
      client.tripWaypointTiming.findMany({
        where: {
          tripId: trip.id,
          routeWaypointId: { in: [originRouteWaypointId, destinationRouteWaypointId] },
        },
        select: { routeWaypointId: true, plannedArrivalAt: true, plannedDepartureAt: true },
      }),
    ]);
    const stopOf = (id: string) => waypoints.find((waypoint) => waypoint.id === id)?.stop ?? null;
    const timingOf = (id: string) => timings.find((timing) => timing.routeWaypointId === id);
    const seats = cells.filter((cell) => cell.kind === 'SEAT');
    return {
      tripId: trip.id,
      tripReference: trip.reference,
      seatMapVersionId: trip.seatMapVersionId,
      origin: {
        routeWaypointId: originRouteWaypointId,
        stop: stopOf(originRouteWaypointId),
        plannedDepartureAt: timingOf(originRouteWaypointId)?.plannedDepartureAt ?? null,
      },
      destination: {
        routeWaypointId: destinationRouteWaypointId,
        stop: stopOf(destinationRouteWaypointId),
        plannedArrivalAt: timingOf(destinationRouteWaypointId)?.plannedArrivalAt ?? null,
      },
      fare: {
        amountMinor: fare.amountMinor,
        currencyCode: fare.currencyCode,
        currencyMinorUnit: fare.currencyMinorUnit,
      },
      maxSeatsPerHold: this.config.maxSeatsPerHold,
      seatCount: seats.length,
      availableSeatCount: seats.filter((cell) => !occupied.has(cell.id)).length,
      cells: cells.map((cell) =>
        cell.kind === 'SEAT' ? { ...cell, available: !occupied.has(cell.id) } : cell,
      ),
    };
  }
}
