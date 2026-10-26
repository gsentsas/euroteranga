'use client';

import type {
  AdminBooking,
  AdminTrip,
  ApiResult,
  Baggage,
  DepartureReadinessResponse,
  OpsProfitTripProjection,
  Page,
  PassengerManifestSummary,
  PublicMedia,
  RoadFreightShipment,
  TripCostPlan,
} from '@euroteranga/auth-client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { auth } from '../../lib/auth';
import { useCan } from '../staff-access';

/**
 * One read of the cockpit. `off` means the viewer lacks the permission: the
 * figure is then not shown at all, never replaced by an invented value.
 * `idle` is an audited read that waits for an explicit request.
 */
export type CockpitSource<T> =
  | { state: 'off' }
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ready'; data: T; partial: boolean };

/** Lists are read page by page; past this many pages the figure is flagged partial. */
const MAX_PAGES = 10;

async function collect<T>(
  load: (cursor?: string) => Promise<ApiResult<Page<T>>>,
): Promise<CockpitSource<T[]>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await load(cursor);
    if (!result.ok) return { state: 'error', error: result.error.message };
    items.push(...result.data.items);
    cursor = result.data.nextCursor ?? undefined;
    if (!cursor) return { state: 'ready', data: items, partial: false };
  }
  return { state: 'ready', data: items, partial: true };
}

async function single<T>(promise: Promise<ApiResult<T>>): Promise<CockpitSource<T>> {
  const result = await promise;
  return result.ok
    ? { state: 'ready', data: result.data, partial: false }
    : { state: 'error', error: result.error.message };
}

const OFF = { state: 'off' } as const;
const IDLE = { state: 'idle' } as const;
const LOADING = { state: 'loading' } as const;

/**
 * Reads the API records against the trip itself (FINANCE/OPS_PROFIT/
 * DEPARTURE_READINESS…_ACCESSED) also fill the trip's 50-event history, and
 * the manifest history is a PII read: none of them runs on mere opening.
 */
export type OnDemandSource = 'profit' | 'readiness' | 'manifests';

export interface TripCockpitData {
  costs: CockpitSource<TripCostPlan>;
  bookings: CockpitSource<AdminBooking[]>;
  baggage: CockpitSource<Baggage[]>;
  cargo: CockpitSource<RoadFreightShipment[]>;
  readiness: CockpitSource<DepartureReadinessResponse>;
  profit: CockpitSource<OpsProfitTripProjection>;
  manifests: CockpitSource<PassengerManifestSummary[]>;
  vehicleMedia: PublicMedia | null;
  supportVehicleMedia: PublicMedia | null;
}

export interface CockpitPermissions {
  bookings: boolean;
  baggage: boolean;
  cargo: boolean;
  departure: boolean;
  finance: boolean;
  manifests: boolean;
  fleet: boolean;
  checkIn: boolean;
  tracking: boolean;
}

export function useCockpitPermissions(): CockpitPermissions {
  return {
    bookings: useCan('booking.read'),
    baggage: useCan('baggage.read'),
    cargo: useCan('cargo.read'),
    departure: useCan('departure.read'),
    // The profitability projection requires both (API guard).
    finance: useCan('finance.read', 'trip.read'),
    manifests: useCan('manifest.read'),
    fleet: useCan('fleet.read'),
    checkIn: useCan('checkin.read'),
    tracking: useCan('tracking.read'),
  };
}

async function vehicleMedia(vehicleId: string | null, allowed: boolean) {
  if (!vehicleId || !allowed) return null;
  const result = await auth.admin.fleet.vehicle(vehicleId);
  return result.ok ? result.data.primaryMedia : null;
}

/**
 * Every read is independent: one refused or failing source never hides the
 * others. Everything is read again whenever the trip itself is reloaded; an
 * on-demand source only once the viewer asked for it on this trip.
 */
export function useTripCockpitData(
  trip: AdminTrip,
  can: CockpitPermissions,
): TripCockpitData & { reload: () => void; request: (source: OnDemandSource) => void } {
  const [data, setData] = useState<TripCockpitData>({
    costs: LOADING,
    bookings: OFF,
    baggage: OFF,
    cargo: OFF,
    readiness: OFF,
    profit: OFF,
    manifests: OFF,
    vehicleMedia: null,
    supportVehicleMedia: null,
  });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((current) => current + 1), []);
  const [requested, setRequested] = useState<{ tripId: string; sources: OnDemandSource[] }>({
    tripId: trip.id,
    sources: [],
  });
  const request = useCallback(
    (source: OnDemandSource) =>
      setRequested((current) => {
        const sources = current.tripId === trip.id ? current.sources : [];
        return sources.includes(source)
          ? current
          : { tripId: trip.id, sources: [...sources, source] };
      }),
    [trip.id],
  );
  const asked = requested.tripId === trip.id ? requested.sources : [];
  const wantsProfit = asked.includes('profit');
  const wantsReadiness = asked.includes('readiness');
  const wantsManifests = asked.includes('manifests');
  // Readiness only describes a departure still to come.
  const readinessAllowed = can.departure && trip.status === 'SCHEDULED';

  useEffect(() => {
    let active = true;
    const reference = trip.reference;
    setData((current) => ({
      ...current,
      costs: LOADING,
      bookings: can.bookings ? LOADING : OFF,
      baggage: can.baggage ? LOADING : OFF,
      cargo: can.cargo ? LOADING : OFF,
    }));
    const update = <K extends keyof TripCockpitData>(key: K) => {
      return (value: TripCockpitData[K]) => {
        if (active) setData((current) => ({ ...current, [key]: value }));
      };
    };
    void single(auth.admin.trips.tripCosts(trip.id)).then(update('costs'));
    if (can.bookings) {
      void collect((cursor) =>
        auth.admin.bookings.bookings({
          tripId: trip.id,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      ).then(update('bookings'));
    }
    if (can.baggage) {
      void collect((cursor) =>
        auth.admin.baggage.list({
          tripReference: reference,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      ).then(update('baggage'));
    }
    if (can.cargo) {
      void collect((cursor) =>
        auth.admin.cargo.list({
          tripReference: reference,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      ).then(update('cargo'));
    }
    void vehicleMedia(trip.vehicleId, can.fleet).then(update('vehicleMedia'));
    void vehicleMedia(trip.supportVehicleId, can.fleet).then(update('supportVehicleMedia'));
    return () => {
      active = false;
    };
    // `trip` changes identity on every reload: everything is read again.
  }, [trip, attempt, can.bookings, can.baggage, can.cargo, can.fleet]);

  useOnDemand(setData, 'profit', can.finance, wantsProfit, trip, attempt, () =>
    single(auth.admin.finance.profitability(trip.reference)),
  );
  useOnDemand(setData, 'readiness', readinessAllowed, wantsReadiness, trip, attempt, () =>
    single(auth.admin.departure.readiness(trip.reference)),
  );
  useOnDemand(setData, 'manifests', can.manifests, wantsManifests, trip, attempt, async () => {
    const result = await auth.admin.manifests.list({ tripReference: trip.reference, limit: 25 });
    return result.ok
      ? { state: 'ready', data: result.data.items, partial: result.data.nextCursor !== null }
      : { state: 'error', error: result.error.message };
  });

  return { ...data, reload, request };
}

/** One on-demand source: off without permission, idle until asked, then read on each reload. */
function useOnDemand<K extends OnDemandSource>(
  setData: Dispatch<SetStateAction<TripCockpitData>>,
  key: K,
  allowed: boolean,
  wanted: boolean,
  trip: AdminTrip,
  attempt: number,
  load: () => Promise<TripCockpitData[K]>,
) {
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let active = true;
    if (!allowed || !wanted) {
      setData((current) => ({ ...current, [key]: allowed ? IDLE : OFF }));
      return;
    }
    setData((current) => ({ ...current, [key]: LOADING }));
    void loadRef.current().then((value) => {
      if (active) setData((current) => ({ ...current, [key]: value }));
    });
    return () => {
      active = false;
    };
  }, [setData, key, allowed, wanted, trip, attempt]);
}
