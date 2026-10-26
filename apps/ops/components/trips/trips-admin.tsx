'use client';

import type {
  AdminTrip,
  AdminTripSummary,
  AdminVehicle,
  NetworkRoute,
  TripStatus,
} from '@euroteranga/auth-client';
import { TextField } from '@euroteranga/ui';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useAdminFeedback } from '../admin/admin-feedback';
import { OpsEmptyState, OpsErrorState, OpsLoadingState } from '../ops-data-state';
import { OpsDetailRegion } from '../ops-detail-region';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
import { usePublishedSeatMapVersions } from '../seat-maps/use-published-versions';
import { useCan } from '../staff-access';
import { TripDetail } from './trip-detail';
import { formatUtc, TRIP_STATUS_LABELS, tripStatusTone, vehicleIdentity } from './trip-format';
import { DEFAULT_TRIP_TAB, isTripTabId, type TripTabId } from './trip-tabs';

type Run = ReturnType<typeof useAdminFeedback>['run'];

interface VersionOption {
  id: string;
  label: string;
}

/**
 * `/trips?fiche=<id>&onglet=<tab>` opens a trip on a tab. The URL is kept in
 * sync with replaceState: the list stays one history entry.
 */
function syncTripUrl(tripId: string | null, tab: TripTabId) {
  const url = new URL(window.location.href);
  if (tripId) url.searchParams.set('fiche', tripId);
  else url.searchParams.delete('fiche');
  if (tripId && tab !== DEFAULT_TRIP_TAB) url.searchParams.set('onglet', tab);
  else url.searchParams.delete('onglet');
  window.history.replaceState(window.history.state, '', url);
}

/** Trips can only be created on a currently PUBLISHED route version. */
function publishedVersions(routes: readonly NetworkRoute[]): VersionOption[] {
  return routes.flatMap((route) =>
    route.versions
      .filter((version) => version.status === 'PUBLISHED')
      .map((version) => ({
        id: version.id,
        label: `${route.code} — ${route.name} · v${version.version}`,
      })),
  );
}

function CreateTripForm({
  versions,
  vehicles,
  run,
  busy,
  onCreated,
}: {
  versions: readonly VersionOption[];
  vehicles: readonly AdminVehicle[];
  run: Run;
  busy: boolean;
  onCreated: (tripId: string) => void;
}) {
  const versionId = useId();
  const vehicleId = useId();
  const [reference, setReference] = useState('');
  const [routeVersionId, setRouteVersionId] = useState('');
  const [vehicle, setVehicle] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    let createdId: string | null = null;
    const ok = await run(async () => {
      const result = await auth.admin.trips.createTrip({
        reference,
        routeVersionId,
        vehicleId: vehicle || null,
      });
      if (result.ok) createdId = result.data.id;
      return result;
    }, `Voyage ${reference.trim().toUpperCase()} créé (brouillon).`);
    if (ok && createdId) {
      setReference('');
      setVehicle('');
      onCreated(createdId);
    }
  };
  return (
    <form className="et-form et-network-form" aria-label="Créer un voyage" onSubmit={submit}>
      <h2>Créer un voyage</h2>
      <TextField
        label="Référence du voyage"
        name="reference"
        value={reference}
        onChange={setReference}
        autoComplete="off"
        maxLength={32}
        hint="Référence publique stable, par exemple ET-TEST-2030-0001."
      />
      <div className="et-field">
        <label htmlFor={versionId}>Version de route publiée</label>
        <select
          id={versionId}
          className="et-select"
          required
          value={routeVersionId}
          onChange={(event) => setRouteVersionId(event.target.value)}
        >
          <option value="">Choisir une version</option>
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.label}
            </option>
          ))}
        </select>
      </div>
      <div className="et-field">
        <label htmlFor={vehicleId}>Véhicule (facultatif)</label>
        <select
          id={vehicleId}
          className="et-select"
          value={vehicle}
          onChange={(event) => setVehicle(event.target.value)}
        >
          <option value="">Aucun véhicule</option>
          {vehicles.map((option) => (
            <option key={option.id} value={option.id}>
              {vehicleIdentity(option)} — {option.manufacturer} {option.model}
            </option>
          ))}
        </select>
      </div>
      <button className="et-button" type="submit" disabled={busy}>
        Créer le voyage
      </button>
    </form>
  );
}

/** Trips (trip.read) and their administration (trip.manage). */
export function TripsAdmin() {
  const canManage = useCan('trip.manage');
  const canAssignSeatMap = useCan('trip.manage', 'seatmap.read');
  const seatMapOptions = usePublishedSeatMapVersions(canAssignSeatMap);
  const canReadPricing = useCan('pricing.read');
  const canAssignPricing = useCan('trip.manage', 'pricing.read');
  const searchParams = useSearchParams();
  const urlTripId = searchParams.get('fiche');
  const initialTab = searchParams.get('onglet');
  const filterId = useId();
  const { run, busy, feedback } = useAdminFeedback();
  const [status, setStatus] = useState<TripStatus | ''>('');
  const [trips, setTrips] = useState<AdminTripSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [vehicles, setVehicles] = useState<AdminVehicle[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('fiche'));
  const [tab, setTab] = useState<TripTabId>(() =>
    isTripTabId(initialTab) ? initialTab : DEFAULT_TRIP_TAB,
  );
  const [detail, setDetail] = useState<AdminTrip | null>(null);
  const urlReady = useRef(false);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const load = useCallback(
    async (cursor?: string) => {
      setListError(null);
      if (!cursor) setTrips(null);
      const result = await auth.admin.trips.trips({
        ...(cursor ? { cursor } : {}),
        ...(status ? { status } : {}),
      });
      if (!result.ok) {
        setListError(result.error.message);
        return;
      }
      setListError(null);
      setTrips((previous) =>
        cursor ? [...(previous ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [status],
  );

  const loadDetail = useCallback(async (tripId: string) => {
    setDetail(null);
    setDetailError(null);
    const result = await auth.admin.trips.trip(tripId);
    if (result.ok) setDetail(result.data);
    else setDetailError(result.error.message);
  }, []);

  /** After a mutation: the open record stays mounted (tab, focus) until fresh data arrives. */
  const refreshDetail = useCallback(async (tripId: string) => {
    const result = await auth.admin.trips.trip(tripId);
    if (result.ok) {
      setDetail(result.data);
      setDetailError(null);
    } else setDetailError(result.error.message);
  }, []);

  const selectTrip = (tripId: string | null) => {
    setSelectedId(tripId);
    setTab(DEFAULT_TRIP_TAB);
  };

  useEffect(() => {
    // The first render keeps the incoming URL untouched.
    if (!urlReady.current) {
      urlReady.current = true;
      return;
    }
    syncTripUrl(selectedId, tab);
  }, [selectedId, tab]);

  // A navigation to /trips?fiche=… while the page is open (global search).
  useEffect(() => {
    const live = new URLSearchParams(window.location.search).get('fiche');
    // Our own replaceState may not have reached useSearchParams yet.
    if (live !== urlTripId) return;
    if (urlTripId && urlTripId !== selectedIdRef.current) {
      setSelectedId(urlTripId);
      const urlTab = new URLSearchParams(window.location.search).get('onglet');
      setTab(isTripTabId(urlTab) ? urlTab : DEFAULT_TRIP_TAB);
    }
  }, [urlTripId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every trip.manage holder also holds network.read and fleet.read.
  useEffect(() => {
    if (!canManage) return;
    void auth.admin.network.routes({ limit: 100 }).then((result) => {
      if (result.ok) setVersions(publishedVersions(result.data.items));
    });
    const loadVehicles = async () => {
      const items: AdminVehicle[] = [];
      let cursor: string | undefined;
      do {
        const result = await auth.admin.fleet.vehicles({
          status: 'ACTIVE',
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (!result.ok) return;
        items.push(...result.data.items);
        cursor = result.data.nextCursor ?? undefined;
      } while (cursor);
      setVehicles(items);
    };
    void loadVehicles();
  }, [canManage]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else {
      setDetail(null);
      setDetailError(null);
    }
  }, [loadDetail, selectedId]);

  const reload = async () => {
    await load();
    if (selectedId) await refreshDetail(selectedId);
  };

  const primaryVehicles = vehicles.filter((vehicle) => vehicle.role !== 'CARGO_SUPPORT');
  const supportVehicles = vehicles.filter(
    (vehicle) =>
      vehicle.role === 'CARGO_SUPPORT' &&
      vehicle.payloadCapacityKg !== null &&
      vehicle.cargoVolumeLiters !== null,
  );

  const visibleTrips = trips ?? [];
  const scheduledCount = visibleTrips.filter((trip) => trip.status === 'SCHEDULED').length;
  const inProgressCount = visibleTrips.filter((trip) => trip.status === 'IN_PROGRESS').length;
  const completedCount = visibleTrips.filter((trip) => trip.status === 'COMPLETED').length;

  return (
    <div
      className="et-network ops-operations-workspace ops-trips-workspace"
      data-testid="trips-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Planification opérationnelle</p>
          <h2>Voyages et rotations</h2>
          <p>
            Un voyage est une occurrence planifiée d’une version de route publiée. Son horaire,
            saisi en UTC, est figé dès la planification ; le véhicule est facultatif.
          </p>
        </div>
      </div>

      {feedback}

      {trips ? (
        <section className="ops-operations-kpis" aria-label="Indicateurs des voyages">
          <OpsKpiCard
            label="Voyages affichés"
            value={visibleTrips.length}
            helper={nextCursor ? 'Liste partielle · autres voyages disponibles' : 'Liste chargée'}
            icon="route"
            tone="info"
          />
          <OpsKpiCard
            label="Planifiés"
            value={scheduledCount}
            helper="Départs préparés"
            icon="dispatch"
            tone="info"
          />
          <OpsKpiCard
            label="En cours"
            value={inProgressCount}
            helper="Rotations actuellement engagées"
            icon="bus"
            tone={inProgressCount > 0 ? 'warning' : 'neutral'}
          />
          <OpsKpiCard
            label="Terminés"
            value={completedCount}
            helper="Voyages clôturés"
            icon="check"
            tone="success"
          />
        </section>
      ) : null}

      {canManage ? (
        <div className="ops-trips-create-panel">
          <CreateTripForm
            versions={versions}
            vehicles={primaryVehicles}
            run={run}
            busy={busy}
            onCreated={(tripId) => {
              void load().then(() => selectTrip(tripId));
            }}
          />
        </div>
      ) : null}

      <section
        className="ops-operations-section ops-operations-section--primary"
        aria-labelledby="trips-title"
      >
        <h2 id="trips-title">Voyages</h2>
        <div className="ops-trips-filter">
          <div className="et-field">
            <label htmlFor={filterId}>Filtrer par statut</label>
            <select
              id={filterId}
              className="et-select"
              value={status}
              onChange={(event) => setStatus(event.target.value as TripStatus | '')}
            >
              <option value="">Tous</option>
              {(Object.keys(TRIP_STATUS_LABELS) as TripStatus[]).map((value) => (
                <option key={value} value={value}>
                  {TRIP_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {!trips && !listError ? <OpsLoadingState title="Chargement des voyages" /> : null}
        {!trips && listError ? (
          <OpsErrorState
            title="Impossible de charger les voyages"
            message={listError}
            onRetry={() => void load()}
          />
        ) : null}
        {trips && trips.length > 0 ? (
          <div className="et-table-wrap">
            <table className="et-table">
              <caption>Voyages</caption>
              <thead>
                <tr>
                  <th scope="col">Référence</th>
                  <th scope="col">Route</th>
                  <th scope="col">Départ prévu</th>
                  <th scope="col">Véhicule</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Fiche</th>
                </tr>
              </thead>
              <tbody>
                {trips.map((trip) => (
                  <tr
                    key={trip.id}
                    className={selectedId === trip.id ? 'ops-table-row--selected' : undefined}
                  >
                    <th scope="row">
                      <span className="et-tag">{trip.reference}</span>
                    </th>
                    <td>
                      {trip.routeVersion.route.code} · v{trip.routeVersion.version}
                    </td>
                    <td>{formatUtc(trip.plannedDepartureAt)}</td>
                    <td>{trip.vehicle?.code ?? '—'}</td>
                    <td>
                      <OpsStatusBadge tone={tripStatusTone(trip.status)}>
                        {TRIP_STATUS_LABELS[trip.status]}
                      </OpsStatusBadge>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Consulter le voyage ${trip.reference}`}
                        aria-controls="trip-detail-panel"
                        aria-expanded={selectedId === trip.id && Boolean(detail)}
                        onClick={() => selectTrip(trip.id)}
                      >
                        Consulter
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {trips?.length === 0 ? (
          <OpsEmptyState
            title="Aucun voyage"
            description="Aucun voyage ne correspond au statut actuellement sélectionné."
          />
        ) : null}
        {trips && listError ? (
          <OpsErrorState
            title="Impossible d’actualiser les voyages"
            message={listError}
            onRetry={() => void load(nextCursor ?? undefined)}
          />
        ) : null}
        {nextCursor ? (
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => void load(nextCursor)}
          >
            Afficher plus
          </button>
        ) : null}
      </section>

      {selectedId && !detail && !detailError ? (
        <OpsLoadingState title="Chargement du voyage" />
      ) : null}
      {selectedId && detailError ? (
        <OpsErrorState
          title="Impossible d’ouvrir ce voyage"
          message={detailError}
          onRetry={() => void loadDetail(selectedId)}
        />
      ) : null}
      {detail ? (
        <OpsDetailRegion
          id="trip-detail-panel"
          focusKey={selectedId}
          onClose={() => selectTrip(null)}
        >
          <TripDetail
            trip={detail}
            vehicles={primaryVehicles}
            supportVehicles={supportVehicles}
            canManage={canManage}
            canAssignSeatMap={canAssignSeatMap}
            seatMapOptions={seatMapOptions}
            canReadPricing={canReadPricing}
            canAssignPricing={canAssignPricing}
            run={run}
            busy={busy}
            onReload={reload}
            tab={tab}
            onTabChange={setTab}
          />
        </OpsDetailRegion>
      ) : null}
    </div>
  );
}
