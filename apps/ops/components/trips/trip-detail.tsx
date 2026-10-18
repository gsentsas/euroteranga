'use client';

import type { AdminTrip, AdminVehicle, TripTimetableInput } from '@euroteranga/auth-client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import type { useAdminFeedback } from '../admin/admin-feedback';
import { OpsConfirmSubmit } from '../ops-confirm-submit';
import { TripPricingPanel } from '../pricing/trip-pricing-panel';
import { assignedLabel } from '../seat-maps/seat-map-format';
import { SeatMapAssignmentForm } from '../seat-maps/seat-map-assignment-form';
import type { PublishedVersionOption } from '../seat-maps/use-published-versions';
import {
  formatLocal,
  formatUtc,
  fromUtcInput,
  placeOf,
  toUtcInput,
  TRIP_ACTION_LABELS,
  TRIP_STATUS_LABELS,
  vehicleIdentity,
} from './trip-format';

type Run = ReturnType<typeof useAdminFeedback>['run'];

interface TimingDraft {
  arrival: string;
  departure: string;
}

function UtcField({
  label,
  value,
  timezone,
  onChange,
}: {
  label: string;
  value: string;
  timezone: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const iso = fromUtcInput(value);
  const local =
    iso && timezone !== 'UTC' && timezone !== 'Etc/UTC' ? formatLocal(iso, timezone) : null;
  return (
    <div className="et-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="et-input"
        type="datetime-local"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {local ? <p className="et-hint">{`Heure locale (${timezone}) : ${local}`}</p> : null}
    </div>
  );
}

/** Only the times are entered: the order comes from the immutable route version. */
function TimetableEditor({
  trip,
  run,
  busy,
  onSaved,
}: {
  trip: AdminTrip;
  run: Run;
  busy: boolean;
  onSaved: () => Promise<void>;
}) {
  const waypoints = trip.routeVersion.waypoints;
  const [drafts, setDrafts] = useState<Record<string, TimingDraft>>({});
  useEffect(() => {
    const byWaypoint = new Map(trip.timings.map((timing) => [timing.routeWaypointId, timing]));
    setDrafts(
      Object.fromEntries(
        waypoints.map((waypoint) => {
          const timing = byWaypoint.get(waypoint.id);
          return [
            waypoint.id,
            {
              arrival: toUtcInput(timing?.plannedArrivalAt ?? null),
              departure: toUtcInput(timing?.plannedDepartureAt ?? null),
            },
          ];
        }),
      ),
    );
  }, [trip, waypoints]);

  const set = (id: string, key: keyof TimingDraft) => (value: string) =>
    setDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { arrival: '', departure: '' }), [key]: value },
    }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const input: TripTimetableInput = {
      timings: waypoints.map((waypoint, index) => {
        const draft = drafts[waypoint.id] ?? { arrival: '', departure: '' };
        return {
          routeWaypointId: waypoint.id,
          plannedArrivalAt: index === 0 ? null : fromUtcInput(draft.arrival),
          plannedDepartureAt: index === waypoints.length - 1 ? null : fromUtcInput(draft.departure),
        };
      }),
    };
    const ok = await run(
      () => auth.admin.trips.replaceTimetable(trip.id, input),
      `Horaire du voyage ${trip.reference} enregistré.`,
    );
    if (ok) await onSaved();
  };

  return (
    <form
      className="et-form et-network-form"
      aria-label={`Horaire du voyage ${trip.reference}`}
      onSubmit={submit}
    >
      <h3>Horaire (UTC)</h3>
      <p className="et-hint">
        Les heures sont saisies et enregistrées en UTC. L’heure locale de chaque point est affichée
        à titre indicatif.
      </p>
      <ol className="et-network-waypoints">
        {waypoints.map((waypoint, index) => {
          const place = placeOf(waypoint);
          const draft = drafts[waypoint.id] ?? { arrival: '', departure: '' };
          return (
            <li key={waypoint.id}>
              <strong>
                {waypoint.sequence}. {place.kind} {place.code} — {place.name}
              </strong>
              {index > 0 ? (
                <UtcField
                  label={`Arrivée à ${place.code} (UTC)`}
                  value={draft.arrival}
                  timezone={place.timezone}
                  onChange={set(waypoint.id, 'arrival')}
                />
              ) : null}
              {index < waypoints.length - 1 ? (
                <UtcField
                  label={`Départ de ${place.code} (UTC)`}
                  value={draft.departure}
                  timezone={place.timezone}
                  onChange={set(waypoint.id, 'departure')}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      <button className="et-button" type="submit" disabled={busy}>
        Enregistrer l’horaire
      </button>
    </form>
  );
}

function VehicleForm({
  trip,
  vehicles,
  run,
  busy,
  onSaved,
}: {
  trip: AdminTrip;
  vehicles: readonly AdminVehicle[];
  run: Run;
  busy: boolean;
  onSaved: () => Promise<void>;
}) {
  const selectId = useId();
  const reasonId = useId();
  const [vehicleId, setVehicleId] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    setVehicleId(trip.vehicleId ?? '');
    setReason('');
  }, [trip.vehicleId]);
  const reasonRequired = trip.status === 'SCHEDULED';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next = vehicleId || null;
    const label = next ? (vehicles.find((vehicle) => vehicle.id === next)?.code ?? next) : 'aucun';
    const ok = await run(
      () =>
        auth.admin.trips.assignTripVehicle(trip.id, {
          vehicleId: next,
          // Refused by the API if the vehicle changed meanwhile.
          expectedVehicleId: trip.vehicleId,
          ...(reason.trim() ? { reason } : {}),
        }),
      `Véhicule du voyage ${trip.reference} : ${label}.`,
    );
    if (ok) await onSaved();
  };
  return (
    <form
      className="et-form et-network-form"
      aria-label={`Véhicule du voyage ${trip.reference}`}
      onSubmit={submit}
    >
      <h3>Véhicule</h3>
      <div className="et-field">
        <label htmlFor={selectId}>Véhicule à affecter</label>
        <select
          id={selectId}
          className="et-select"
          value={vehicleId}
          onChange={(event) => setVehicleId(event.target.value)}
        >
          <option value="">Aucun véhicule</option>
          {trip.vehicle && !vehicles.some((vehicle) => vehicle.id === trip.vehicle?.id) ? (
            <option value={trip.vehicle.id}>{`${trip.vehicle.code} (actuel)`}</option>
          ) : null}
          {vehicles.map((vehicle) => (
            <option key={vehicle.id} value={vehicle.id}>
              {vehicleIdentity(vehicle)} — {vehicle.manufacturer} {vehicle.model}
            </option>
          ))}
        </select>
        <p className="et-hint">Seuls les véhicules en service sont proposés.</p>
      </div>
      <div className="et-field">
        <label htmlFor={reasonId}>
          {reasonRequired
            ? 'Motif du changement de véhicule'
            : 'Motif du changement de véhicule (facultatif)'}
        </label>
        <textarea
          id={reasonId}
          className="et-input"
          rows={2}
          minLength={3}
          maxLength={500}
          required={reasonRequired}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <button className="et-button" type="submit" disabled={busy}>
        Enregistrer le véhicule
      </button>
    </form>
  );
}

function CancelForm({
  trip,
  run,
  busy,
  onSaved,
}: {
  trip: AdminTrip;
  run: Run;
  busy: boolean;
  onSaved: () => Promise<void>;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const ok = await run(
      () => auth.admin.trips.cancelTrip(trip.id, { reason, expectedStatus: trip.status }),
      `Voyage ${trip.reference} annulé.`,
    );
    if (ok) {
      setReason('');
      await onSaved();
    }
  };
  return (
    <form
      className="et-form et-network-form"
      aria-label={`Annuler le voyage ${trip.reference}`}
      onSubmit={submit}
    >
      <h3>Annulation</h3>
      <div className="et-field">
        <label htmlFor={reasonId}>Motif de l’annulation</label>
        <textarea
          id={reasonId}
          className="et-input"
          rows={2}
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <p className="et-hint">L’annulation est définitive.</p>
      <OpsConfirmSubmit
        actionLabel="Annuler le voyage"
        confirmLabel="Confirmer l’annulation"
        title={`Confirmer l’annulation du voyage ${trip.reference}`}
        description="Le voyage passera définitivement au statut annulé et ne pourra plus être modifié."
        disabled={busy || reason.trim().length < 3}
      />
    </form>
  );
}

function TripSeatMapPanel({
  trip,
  canAssign,
  options,
  run,
  busy,
  onReload,
}: {
  trip: AdminTrip;
  canAssign: boolean;
  options: readonly PublishedVersionOption[];
  run: Run;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  const vehicleSeatMap = trip.vehicle?.seatMapVersion ?? null;
  const editable = canAssign && trip.status === 'DRAFT';
  const applyVehicleSeatMap = async () => {
    if (!vehicleSeatMap || busy) return;
    const ok = await run(
      () =>
        auth.admin.trips.assignTripSeatMap(trip.id, {
          seatMapVersionId: vehicleSeatMap.id,
          expectedSeatMapVersionId: trip.seatMapVersionId,
        }),
      `Plan de sièges du voyage ${trip.reference} : ${assignedLabel(vehicleSeatMap)}.`,
    );
    if (ok) await onReload();
  };
  return (
    <section aria-labelledby="trip-seat-map-title">
      <h3 id="trip-seat-map-title">Plan de sièges</h3>
      <p>
        Plan du voyage :{' '}
        <strong data-testid="trip-seat-map">{assignedLabel(trip.seatMapVersion)}</strong>
      </p>
      {trip.vehicle ? (
        <p className="et-hint">Plan actuel du véhicule : {assignedLabel(vehicleSeatMap)}</p>
      ) : null}
      {trip.status !== 'DRAFT' ? (
        <p className="et-hint">
          Le plan de sièges est figé : il fait partie de l’historique du voyage.
        </p>
      ) : null}
      {editable && vehicleSeatMap && vehicleSeatMap.id !== trip.seatMapVersionId ? (
        <button
          type="button"
          className="et-button"
          disabled={busy}
          onClick={() => void applyVehicleSeatMap()}
        >
          Utiliser le plan du véhicule
        </button>
      ) : null}
      {editable ? (
        <SeatMapAssignmentForm
          formLabel={`Plan de sièges du voyage ${trip.reference}`}
          selectLabel="Plan de sièges du voyage"
          submitLabel="Enregistrer le plan du voyage"
          currentId={trip.seatMapVersionId}
          currentLabel={assignedLabel(trip.seatMapVersion)}
          options={options}
          run={run}
          busy={busy}
          success={(label) => `Plan de sièges du voyage ${trip.reference} : ${label}.`}
          assign={(seatMapVersionId, expected) =>
            auth.admin.trips.assignTripSeatMap(trip.id, {
              seatMapVersionId,
              expectedSeatMapVersionId: expected,
            })
          }
          onSaved={onReload}
        />
      ) : null}
    </section>
  );
}

export function TripDetail({
  trip,
  vehicles,
  canManage,
  canAssignSeatMap,
  seatMapOptions,
  canReadPricing,
  canAssignPricing,
  run,
  busy,
  onReload,
}: {
  trip: AdminTrip;
  vehicles: readonly AdminVehicle[];
  canManage: boolean;
  /** trip.manage + seatmap.read. */
  canAssignSeatMap: boolean;
  seatMapOptions: readonly PublishedVersionOption[];
  /** pricing.read. */
  canReadPricing: boolean;
  /** trip.manage + pricing.read. */
  canAssignPricing: boolean;
  run: Run;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  const byWaypoint = new Map(trip.timings.map((timing) => [timing.routeWaypointId, timing]));
  const editable = canManage && trip.status === 'DRAFT';
  const schedule = async () => {
    if (busy) return;
    const ok = await run(
      () => auth.admin.trips.scheduleTrip(trip.id),
      `Voyage ${trip.reference} planifié.`,
    );
    if (ok) await onReload();
  };
  return (
    <section aria-labelledby="trip-detail-title" className="et-network-panel">
      <h2 id="trip-detail-title">Voyage {trip.reference}</h2>
      <dl data-testid="trip-detail">
        <dt>Statut</dt>
        <dd data-testid="trip-status">{TRIP_STATUS_LABELS[trip.status]}</dd>
        <dt>Route</dt>
        <dd>
          {trip.routeVersion.route.code} — {trip.routeVersion.route.name}, version{' '}
          {trip.routeVersion.version}
          {trip.routeVersion.status === 'RETIRED'
            ? ' (version retirée depuis ; le voyage reste valide)'
            : ''}
        </dd>
        <dt>Départ prévu</dt>
        <dd>{formatUtc(trip.plannedDepartureAt)}</dd>
        <dt>Arrivée prévue</dt>
        <dd>{formatUtc(trip.plannedArrivalAt)}</dd>
        <dt>Véhicule</dt>
        <dd data-testid="trip-vehicle">
          {trip.vehicle
            ? `${vehicleIdentity(trip.vehicle)} — ${trip.vehicle.manufacturer} ${trip.vehicle.model}`
            : 'Aucun'}
        </dd>
      </dl>

      {editable ? (
        <TimetableEditor trip={trip} run={run} busy={busy} onSaved={onReload} />
      ) : (
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>{`Horaire du voyage ${trip.reference} (UTC)`}</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Point</th>
                <th scope="col">Arrivée</th>
                <th scope="col">Départ</th>
              </tr>
            </thead>
            <tbody>
              {trip.routeVersion.waypoints.map((waypoint) => {
                const place = placeOf(waypoint);
                const timing = byWaypoint.get(waypoint.id);
                return (
                  <tr key={waypoint.id}>
                    <td>{waypoint.sequence}</td>
                    <th scope="row">
                      {place.kind} {place.code} — {place.name}
                    </th>
                    <td>{formatUtc(timing?.plannedArrivalAt ?? null)}</td>
                    <td>{formatUtc(timing?.plannedDepartureAt ?? null)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <TripSeatMapPanel
        trip={trip}
        canAssign={canAssignSeatMap}
        options={seatMapOptions}
        run={run}
        busy={busy}
        onReload={onReload}
      />

      {canReadPricing ? (
        <TripPricingPanel
          trip={trip}
          canAssign={canAssignPricing}
          run={run}
          busy={busy}
          onReload={onReload}
        />
      ) : null}

      {canManage && trip.status !== 'CANCELLED' ? (
        <VehicleForm trip={trip} vehicles={vehicles} run={run} busy={busy} onSaved={onReload} />
      ) : null}
      {editable ? (
        <div className="et-actions">
          <button
            type="button"
            className="et-button"
            disabled={busy}
            onClick={() => void schedule()}
          >
            Planifier le voyage
          </button>
          <p className="et-hint">La planification fige l’horaire.</p>
        </div>
      ) : null}
      {canManage && trip.status !== 'CANCELLED' ? (
        <CancelForm trip={trip} run={run} busy={busy} onSaved={onReload} />
      ) : null}
      {trip.status === 'CANCELLED' ? (
        <p>Ce voyage est annulé : il ne peut plus être modifié.</p>
      ) : null}

      <h3>Historique</h3>
      <ol aria-label={`Historique du voyage ${trip.reference}`}>
        {trip.history.map((entry) => (
          <li key={`${entry.occurredAt}-${entry.action}`}>
            <time dateTime={entry.occurredAt}>{formatUtc(entry.occurredAt)}</time> :{' '}
            {TRIP_ACTION_LABELS[entry.action] ?? entry.action}
            {entry.toStatus && entry.fromStatus
              ? ` (${TRIP_STATUS_LABELS[entry.fromStatus]} → ${TRIP_STATUS_LABELS[entry.toStatus]})`
              : ''}
            {entry.action === 'TRIP_VEHICLE_CHANGED'
              ? ` (${entry.fromVehicleCode ?? 'aucun'} → ${entry.toVehicleCode ?? 'aucun'})`
              : ''}
            {entry.action === 'TRIP_FARE_TABLE_CHANGED'
              ? ` (${entry.fromFareTable ?? 'aucune'} → ${entry.toFareTable ?? 'aucune'})`
              : ''}
            {entry.reason ? ` — ${entry.reason}` : ''}
          </li>
        ))}
      </ol>
    </section>
  );
}
