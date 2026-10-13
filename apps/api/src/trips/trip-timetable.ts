/**
 * Timetable rules, shared by timetable replacement and scheduling. The PR-06
 * migration enforces the same rules in PostgreSQL (trip_timetable_error) when
 * a trip becomes SCHEDULED; this copy gives callers precise public errors.
 *
 * - exactly one timing per waypoint of the route version;
 * - first waypoint: departure only; last waypoint: arrival only;
 * - intermediate waypoints: arrival and departure, arrival <= departure;
 * - each arrival strictly after the previous waypoint's departure.
 */
export interface TimetableWaypoint {
  id: string;
  sequence: number;
}

export interface TimetableEntry {
  routeWaypointId: string;
  plannedArrivalAt: Date | null;
  plannedDepartureAt: Date | null;
}

export type TimetableCheck =
  | {
      ok: true;
      timings: Array<TimetableEntry & { sequence: number }>;
      plannedDepartureAt: Date;
      plannedArrivalAt: Date;
    }
  | { ok: false; message: string };

const fail = (message: string): TimetableCheck => ({ ok: false, message });

export function checkTimetable(
  waypoints: readonly TimetableWaypoint[],
  entries: readonly TimetableEntry[],
): TimetableCheck {
  const ordered = [...waypoints].sort((left, right) => left.sequence - right.sequence);
  if (ordered.length < 2) return fail('La version de route doit compter au moins deux points.');

  const byWaypoint = new Map<string, TimetableEntry>();
  for (const entry of entries) {
    if (byWaypoint.has(entry.routeWaypointId)) {
      return fail('Chaque point de la route ne peut avoir qu’un seul horaire.');
    }
    byWaypoint.set(entry.routeWaypointId, entry);
  }
  if (
    byWaypoint.size !== ordered.length ||
    ordered.some((waypoint) => !byWaypoint.has(waypoint.id))
  ) {
    return fail('L’horaire doit couvrir exactement les points de la version de route.');
  }

  const timings = ordered.map((waypoint) => ({
    ...(byWaypoint.get(waypoint.id) as TimetableEntry),
    sequence: waypoint.sequence,
  }));
  let previousDeparture: Date | null = null;
  for (const [index, timing] of timings.entries()) {
    const position = index + 1;
    const arrival = timing.plannedArrivalAt;
    const departure = timing.plannedDepartureAt;
    if (index === 0) {
      if (arrival !== null || departure === null) {
        return fail('Le premier point n’a qu’une heure de départ.');
      }
    } else if (index === timings.length - 1) {
      if (arrival === null || departure !== null) {
        return fail('Le dernier point n’a qu’une heure d’arrivée.');
      }
    } else if (arrival === null || departure === null || arrival > departure) {
      return fail(`Le point ${position} doit avoir une arrivée antérieure ou égale à son départ.`);
    }
    if (previousDeparture !== null && arrival !== null && arrival <= previousDeparture) {
      return fail(`L’arrivée au point ${position} doit être postérieure au départ précédent.`);
    }
    previousDeparture = departure;
  }

  const first = timings[0];
  const last = timings.at(-1);
  if (!first?.plannedDepartureAt || !last?.plannedArrivalAt) {
    return fail('L’horaire est incomplet.');
  }
  return {
    ok: true,
    timings,
    plannedDepartureAt: first.plannedDepartureAt,
    plannedArrivalAt: last.plannedArrivalAt,
  };
}
