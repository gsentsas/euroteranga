import type { DatabaseTransaction } from '@euroteranga/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { isFarePair } from './fare-entries.js';
import { PricingErrors } from './pricing.errors.js';

export interface ResolvedTripFare {
  tripId: string;
  fareTableId: string;
  fareTableCode: string;
  fareTableVersionId: string;
  fareTableVersion: number;
  fareEntryId: string;
  originRouteWaypointId: string;
  destinationRouteWaypointId: string;
  /** Exact amount in the currency's minor unit. */
  amountMinor: number;
  currencyCode: string;
  currencyMinorUnit: number;
}

/**
 * Exact fare lookup shared by Pricing (trip fare endpoint) and Booking (hold
 * creation): the fare configured for this origin/destination pair in the
 * trip's historical fare table version. No fallback, no distance, no
 * interpolation. Each caller maps the failure reasons to its own errors.
 */
export type TripFareLookup =
  | {
      ok: true;
      fareEntryId: string;
      amountMinor: number;
      currencyCode: string;
      currencyMinorUnit: number;
      fareTableId: string;
      fareTableCode: string;
      fareTableVersionId: string;
      fareTableVersion: number;
      originSequence: number;
      destinationSequence: number;
    }
  | { ok: false; reason: 'PRICING_NOT_CONFIGURED' | 'WAYPOINT_INVALID' | 'FARE_NOT_CONFIGURED' };

export async function findTripFare(
  client: DatabaseTransaction,
  trip: { routeVersionId: string; fareTableVersionId: string | null },
  originRouteWaypointId: string,
  destinationRouteWaypointId: string,
): Promise<TripFareLookup> {
  if (!trip.fareTableVersionId) return { ok: false, reason: 'PRICING_NOT_CONFIGURED' };
  const pricing = await client.fareTableVersion.findUnique({
    where: { id: trip.fareTableVersionId },
    select: {
      id: true,
      version: true,
      fareTable: {
        select: { id: true, code: true, currencyCode: true, currencyMinorUnit: true },
      },
    },
  });
  if (!pricing) return { ok: false, reason: 'PRICING_NOT_CONFIGURED' };

  const waypoints = await client.routeWaypoint.findMany({
    where: {
      id: { in: [originRouteWaypointId, destinationRouteWaypointId] },
      routeVersionId: trip.routeVersionId,
    },
    select: {
      id: true,
      sequence: true,
      stopId: true,
      boardingAllowed: true,
      alightingAllowed: true,
    },
  });
  const view = (id: string) => {
    const waypoint = waypoints.find((candidate) => candidate.id === id);
    return waypoint
      ? {
          id: waypoint.id,
          sequence: waypoint.sequence,
          isStop: waypoint.stopId !== null,
          boardingAllowed: waypoint.boardingAllowed,
          alightingAllowed: waypoint.alightingAllowed,
          label: '',
        }
      : null;
  };
  const origin = view(originRouteWaypointId);
  const destination = view(destinationRouteWaypointId);
  if (!origin || !destination || !isFarePair(origin, destination)) {
    return { ok: false, reason: 'WAYPOINT_INVALID' };
  }

  const entry = await client.fareEntry.findUnique({
    where: {
      fareTableVersionId_originRouteWaypointId_destinationRouteWaypointId: {
        fareTableVersionId: pricing.id,
        originRouteWaypointId,
        destinationRouteWaypointId,
      },
    },
    select: { id: true, amountMinor: true },
  });
  if (!entry) return { ok: false, reason: 'FARE_NOT_CONFIGURED' };
  return {
    ok: true,
    fareEntryId: entry.id,
    amountMinor: entry.amountMinor,
    currencyCode: pricing.fareTable.currencyCode,
    currencyMinorUnit: pricing.fareTable.currencyMinorUnit,
    fareTableId: pricing.fareTable.id,
    fareTableCode: pricing.fareTable.code,
    fareTableVersionId: pricing.id,
    fareTableVersion: pricing.version,
    originSequence: origin.sequence,
    destinationSequence: destination.sequence,
  };
}

/**
 * Server-side fare resolution: the exact base fare configured for this
 * origin/destination pair in the trip's historical fare table version.
 * No fallback, no distance, no interpolation. Not a booking or a quote.
 */
@Injectable()
export class FareResolutionService {
  constructor(private readonly database: DatabaseService) {}

  async resolve(
    tripId: string,
    originRouteWaypointId: string,
    destinationRouteWaypointId: string,
  ): Promise<ResolvedTripFare> {
    const trip = await this.database.client.trip.findUnique({
      where: { id: tripId },
      select: { routeVersionId: true, fareTableVersionId: true },
    });
    if (!trip) throw PricingErrors.tripNotFound();
    const fare = await findTripFare(
      this.database.client,
      trip,
      originRouteWaypointId,
      destinationRouteWaypointId,
    );
    if (!fare.ok) {
      if (fare.reason === 'PRICING_NOT_CONFIGURED') throw PricingErrors.tripPricingNotConfigured();
      if (fare.reason === 'WAYPOINT_INVALID') throw PricingErrors.fareWaypointInvalid();
      throw PricingErrors.fareNotConfigured();
    }
    return {
      tripId,
      fareTableId: fare.fareTableId,
      fareTableCode: fare.fareTableCode,
      fareTableVersionId: fare.fareTableVersionId,
      fareTableVersion: fare.fareTableVersion,
      fareEntryId: fare.fareEntryId,
      originRouteWaypointId,
      destinationRouteWaypointId,
      amountMinor: fare.amountMinor,
      currencyCode: fare.currencyCode,
      currencyMinorUnit: fare.currencyMinorUnit,
    };
  }
}
