'use client';

import type {
  AdminTrip,
  AdminTripSummary,
  AdminVehicle,
  NetworkRoute,
  TripStatus,
} from '@euroteranga/auth-client';
import { TextField } from '@euroteranga/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { useAdminFeedback } from '../admin/admin-feedback';
import { OpsDetailRegion } from '../ops-detail-region';
import { usePublishedSeatMapVersions } from '../seat-maps/use-published-versions';
import { useCan } from '../staff-access';
import { TripDetail } from './trip-detail';
import { formatUtc, TRIP_STATUS_LABELS } from './trip-format';

type Run = ReturnType<typeof useAdminFeedback>['run'];

interface VersionOption {
  id: string;
  label: string;
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
              {option.code} — {option.manufacturer} {option.model}
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
  const filterId = useId();
  const { run, busy, feedback, setError } = useAdminFeedback();
  const [status, setStatus] = useState<TripStatus | ''>('');
  const [trips, setTrips] = useState<AdminTripSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [vehicles, setVehicles] = useState<AdminVehicle[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminTrip | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      const result = await auth.admin.trips.trips({
        ...(cursor ? { cursor } : {}),
        ...(status ? { status } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setTrips((previous) =>
        cursor ? [...(previous ?? []), ...result.data.items] : result.data.items,
      );
      setNextCursor(result.data.nextCursor);
    },
    [setError, status],
  );

  const loadDetail = useCallback(
    async (tripId: string) => {
      const result = await auth.admin.trips.trip(tripId);
      if (result.ok) setDetail(result.data);
      else setError(result.error.message);
    },
    [setError],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Every trip.manage holder also holds network.read and fleet.read.
  useEffect(() => {
    if (!canManage) return;
    void auth.admin.network.routes({ limit: 100 }).then((result) => {
      if (result.ok) setVersions(publishedVersions(result.data.items));
    });
    void auth.admin.fleet.vehicles({ status: 'ACTIVE', limit: 100 }).then((result) => {
      if (result.ok) setVehicles(result.data.items);
    });
  }, [canManage]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [loadDetail, selectedId]);

  const reload = async () => {
    await load();
    if (selectedId) await loadDetail(selectedId);
  };

  if (!trips) return <p role="status">Chargement des voyages…</p>;

  return (
    <div className="et-network" data-testid="trips-workspace">
      <p>
        Un voyage est une occurrence planifiée d’une version de route publiée. Son horaire, saisi en
        UTC, est figé dès la planification ; le véhicule est facultatif.
      </p>
      {feedback}
      {canManage ? (
        <CreateTripForm
          versions={versions}
          vehicles={vehicles}
          run={run}
          busy={busy}
          onCreated={(tripId) => {
            void load().then(() => setSelectedId(tripId));
          }}
        />
      ) : null}

      <section aria-labelledby="trips-title">
        <h2 id="trips-title">Voyages</h2>
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
                <tr key={trip.id}>
                  <th scope="row">
                    <span className="et-tag">{trip.reference}</span>
                  </th>
                  <td>
                    {trip.routeVersion.route.code} · v{trip.routeVersion.version}
                  </td>
                  <td>{formatUtc(trip.plannedDepartureAt)}</td>
                  <td>{trip.vehicle?.code ?? '—'}</td>
                  <td>{TRIP_STATUS_LABELS[trip.status]}</td>
                  <td>
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      aria-label={`Consulter le voyage ${trip.reference}`}
                      aria-controls="trip-detail-panel"
                      aria-expanded={selectedId === trip.id && Boolean(detail)}
                      onClick={() => setSelectedId(trip.id)}
                    >
                      Consulter
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {trips.length === 0 ? <p>Aucun voyage.</p> : null}
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

      {selectedId && !detail ? <p role="status">Chargement du voyage…</p> : null}
      {detail ? (
        <OpsDetailRegion id="trip-detail-panel" focusKey={selectedId}>
          <TripDetail
            trip={detail}
            vehicles={vehicles}
            canManage={canManage}
            canAssignSeatMap={canAssignSeatMap}
            seatMapOptions={seatMapOptions}
            canReadPricing={canReadPricing}
            canAssignPricing={canAssignPricing}
            run={run}
            busy={busy}
            onReload={reload}
          />
        </OpsDetailRegion>
      ) : null}
    </div>
  );
}
