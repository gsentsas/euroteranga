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
      select: {
        routeVersionId: true,
        fareTableVersion: {
          select: {
            id: true,
            version: true,
            fareTable: {
              select: { id: true, code: true, currencyCode: true, currencyMinorUnit: true },
            },
          },
        },
      },
    });
    if (!trip) throw PricingErrors.tripNotFound();
    const pricing = trip.fareTableVersion;
    if (!pricing) throw PricingErrors.tripPricingNotConfigured();

    const waypoints = await this.database.client.routeWaypoint.findMany({
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
      throw PricingErrors.fareWaypointInvalid();
    }

    const entry = await this.database.client.fareEntry.findUnique({
      where: {
        fareTableVersionId_originRouteWaypointId_destinationRouteWaypointId: {
          fareTableVersionId: pricing.id,
          originRouteWaypointId,
          destinationRouteWaypointId,
        },
      },
      select: { id: true, amountMinor: true },
    });
    if (!entry) throw PricingErrors.fareNotConfigured();
    return {
      tripId,
      fareTableId: pricing.fareTable.id,
      fareTableCode: pricing.fareTable.code,
      fareTableVersionId: pricing.id,
      fareTableVersion: pricing.version,
      fareEntryId: entry.id,
      originRouteWaypointId,
      destinationRouteWaypointId,
      amountMinor: entry.amountMinor,
      currencyCode: pricing.fareTable.currencyCode,
      currencyMinorUnit: pricing.fareTable.currencyMinorUnit,
    };
  }
}
