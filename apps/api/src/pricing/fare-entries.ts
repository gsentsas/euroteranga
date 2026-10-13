/**
 * Fare matrix rules, shared by fare replacement and publication. PostgreSQL
 * enforces the same rules (fare_entry_guard, CHECKs, unique index); this copy
 * gives callers precise public errors. The matrix may be partial: nothing is
 * ever derived for a missing pair.
 */
export interface FareWaypoint {
  id: string;
  sequence: number;
  isStop: boolean;
  boardingAllowed: boolean;
  alightingAllowed: boolean;
  label: string;
}

export interface FareInput {
  originRouteWaypointId: string;
  destinationRouteWaypointId: string;
  amountMinor: number;
}

export type FaresCheck = { ok: true; fares: FareInput[] } | { ok: false; message: string };

/** Largest amount storable in the INTEGER column. */
export const MAX_AMOUNT_MINOR = 2_147_483_647;

/**
 * Can a passenger board at `origin` and alight at `destination`? The same
 * rule decides which pairs may carry a fare and which pairs can be resolved.
 */
export function isFarePair(origin: FareWaypoint, destination: FareWaypoint): boolean {
  return (
    origin.isStop &&
    destination.isStop &&
    origin.boardingAllowed &&
    destination.alightingAllowed &&
    origin.sequence < destination.sequence
  );
}

export function checkFares(
  waypoints: readonly FareWaypoint[],
  fares: readonly FareInput[],
): FaresCheck {
  const byId = new Map(waypoints.map((waypoint) => [waypoint.id, waypoint]));
  const pairs = new Set<string>();
  for (const fare of fares) {
    const origin = byId.get(fare.originRouteWaypointId);
    const destination = byId.get(fare.destinationRouteWaypointId);
    if (!origin || !destination) {
      return { ok: false, message: 'Chaque tarif doit relier deux points de la version de route.' };
    }
    if (!origin.isStop || !destination.isStop) {
      return {
        ok: false,
        message: 'Les tarifs relient uniquement des arrêts (pas de checkpoint).',
      };
    }
    if (!origin.boardingAllowed) {
      return { ok: false, message: `La montée n’est pas autorisée à ${origin.label}.` };
    }
    if (!destination.alightingAllowed) {
      return { ok: false, message: `La descente n’est pas autorisée à ${destination.label}.` };
    }
    if (origin.sequence >= destination.sequence) {
      return {
        ok: false,
        message: `L’origine ${origin.label} doit précéder la destination ${destination.label}.`,
      };
    }
    if (
      !Number.isSafeInteger(fare.amountMinor) ||
      fare.amountMinor < 1 ||
      fare.amountMinor > MAX_AMOUNT_MINOR
    ) {
      return { ok: false, message: 'Chaque montant doit être un entier positif en unité mineure.' };
    }
    const key = `${origin.id}>${destination.id}`;
    if (pairs.has(key)) {
      return {
        ok: false,
        message: `Le trajet ${origin.label} → ${destination.label} est tarifé deux fois.`,
      };
    }
    pairs.add(key);
  }
  return { ok: true, fares: [...fares] };
}
