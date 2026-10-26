'use client';

import type {
  AdminTrip,
  AdminVehicle,
  Baggage,
  TripTimetableInput,
} from '@euroteranga/auth-client';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { auth } from '../../lib/auth';
import type { useAdminFeedback } from '../admin/admin-feedback';
import { MediaThumb } from '../media/media-shared';
import { OpsConfirmSubmit } from '../ops-confirm-submit';
import { OpsStatusBadge, OpsTabs } from '../ops-ui';
import { TripPricingPanel } from '../pricing/trip-pricing-panel';
import { assignedLabel } from '../seat-maps/seat-map-format';
import { SeatMapAssignmentForm } from '../seat-maps/seat-map-assignment-form';
import type { PublishedVersionOption } from '../seat-maps/use-published-versions';
import { useCockpitPermissions, useTripCockpitData, type CockpitSource } from './trip-cockpit-data';
import {
  CockpitKpi,
  CockpitMenu,
  KpiAmount,
  RouteSchematic,
  TripHistoryList,
  VehicleCard,
  type CockpitMenuItem,
} from './trip-cockpit-parts';
import { TripCostPanel } from './trip-cost-panel';
import {
  formatCargoVolume,
  formatDuration,
  formatKg,
  formatLocal,
  formatLocalTime,
  formatMinor,
  formatUtc,
  formatUtcDay,
  formatUtcTime,
  fromUtcInput,
  placeOf,
  toUtcInput,
  TRIP_STATUS_LABELS,
  tripEnds,
  tripStatusTone,
  vehicleIdentity,
} from './trip-format';
import { tripPageHref } from './trip-link';
import { BaggagePanel, CargoPanel, DocumentsPanel, PassengersPanel } from './trip-ops-panels';
import {
  bookingFigures,
  costStatusLabel,
  OnDemandButton,
  TripOverview,
  tripAlerts,
  type TripEditTarget,
} from './trip-overview';
import { TRIP_TABS, type TripTabId } from './trip-tabs';

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

function SupportVehicleForm({
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
    setVehicleId(trip.supportVehicleId ?? '');
    setReason('');
  }, [trip.supportVehicleId]);

  const reasonRequired = trip.status === 'SCHEDULED';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next = vehicleId || null;
    const label = next ? (vehicles.find((vehicle) => vehicle.id === next)?.code ?? next) : 'aucun';
    const ok = await run(
      () =>
        auth.admin.trips.assignTripSupportVehicle(trip.id, {
          supportVehicleId: next,
          expectedSupportVehicleId: trip.supportVehicleId,
          ...(reason.trim() ? { reason } : {}),
        }),
      `Véhicule d’appoint du voyage ${trip.reference} : ${label}.`,
    );
    if (ok) await onSaved();
  };

  return (
    <form
      className="et-form et-network-form"
      aria-label={`Véhicule d’appoint du voyage ${trip.reference}`}
      onSubmit={submit}
    >
      <h3>Véhicule d’appoint</h3>
      <div className="et-field">
        <label htmlFor={selectId}>Véhicule CARGO_SUPPORT à affecter</label>
        <select
          id={selectId}
          className="et-select"
          value={vehicleId}
          onChange={(event) => setVehicleId(event.target.value)}
        >
          <option value="">Aucun véhicule d’appoint</option>
          {trip.supportVehicle &&
          !vehicles.some((vehicle) => vehicle.id === trip.supportVehicle?.id) ? (
            <option value={trip.supportVehicle.id}>{`${trip.supportVehicle.code} (actuel)`}</option>
          ) : null}
          {vehicles.map((vehicle) => (
            <option key={vehicle.id} value={vehicle.id}>
              {`${vehicleIdentity(vehicle)} — ${vehicle.manufacturer} ${vehicle.model} · ${vehicle.payloadCapacityKg ?? '—'} kg · ${formatCargoVolume(vehicle.cargoVolumeLiters)}`}
            </option>
          ))}
        </select>
        <p className="et-hint">
          Seuls les véhicules CARGO_SUPPORT actifs avec capacité configurée sont proposés.
        </p>
      </div>
      <div className="et-field">
        <label htmlFor={reasonId}>
          {reasonRequired
            ? 'Motif du changement de véhicule d’appoint'
            : 'Motif du changement de véhicule d’appoint (facultatif)'}
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
        Enregistrer le véhicule d’appoint
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

/** Frame of an open editor: takes the focus when it opens, closes on request. */
function EditorFrame({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <div ref={ref} tabIndex={-1} className="ops-trip-editor" role="group" aria-label={label}>
      {children}
      <button type="button" className="et-button et-button--secondary" onClick={onClose}>
        Fermer l’édition
      </button>
    </div>
  );
}

function TripSeatMapPanel({
  trip,
  canAssign,
  options,
  run,
  busy,
  onReload,
  editing,
  onEdit,
  onClose,
}: {
  trip: AdminTrip;
  canAssign: boolean;
  options: readonly PublishedVersionOption[];
  run: Run;
  busy: boolean;
  onReload: () => Promise<void>;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
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
    <section className="ops-trip-card" aria-labelledby="trip-seat-map-title">
      <div className="ops-trip-section-head">
        <h3 id="trip-seat-map-title">Plan de sièges</h3>
        {editable && !editing ? (
          <div className="ops-trip-section-head__actions">
            {vehicleSeatMap && vehicleSeatMap.id !== trip.seatMapVersionId ? (
              <button
                type="button"
                className="et-button"
                disabled={busy}
                onClick={() => void applyVehicleSeatMap()}
              >
                Utiliser le plan du véhicule
              </button>
            ) : null}
            <button
              id="trip-edit-seatMap"
              type="button"
              className="et-button et-button--secondary"
              onClick={onEdit}
            >
              Modifier le plan de sièges
            </button>
          </div>
        ) : null}
      </div>
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
      {editable && editing ? (
        <EditorFrame label="Modification du plan de sièges" onClose={onClose}>
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
            onSaved={async () => {
              onClose();
              await onReload();
            }}
          />
        </EditorFrame>
      ) : null}
    </section>
  );
}

const EDIT_TARGET_TAB: Record<TripEditTarget, TripTabId> = {
  timetable: 'itineraire',
  vehicle: 'vehicules',
  support: 'vehicules',
  seatMap: 'vehicules',
  pricing: 'tarification',
  costs: 'couts',
};

const EDIT_TARGET_LABELS: Record<TripEditTarget, string> = {
  timetable: 'Horaire',
  vehicle: 'Véhicule principal',
  support: 'Véhicule d’appoint',
  seatMap: 'Plan de sièges',
  pricing: 'Tarification',
  costs: 'Coûts prévisionnels',
};

/** Where one end of the trip leaves or arrives: city, code, UTC day and time. */
function JourneyEnd({
  label,
  place,
  at,
}: {
  label: string;
  place: ReturnType<typeof placeOf> | null;
  at: string | null;
}) {
  const local = at && place ? formatLocalTime(at, place.timezone) : null;
  return (
    <div className="ops-trip-hero__end">
      <span className="ops-trip-hero__end-label">{label}</span>
      <strong>
        {place?.name ?? '—'} <span className="et-code">{place?.code ?? '—'}</span>
      </strong>
      {at ? (
        <>
          <span>{formatUtcDay(at)}</span>
          <span className="ops-trip-hero__time">{formatUtcTime(at)}</span>
          {local ? <small>{`Heure locale ${local} (${place?.timezone})`}</small> : null}
        </>
      ) : (
        <span>Horaire à définir</span>
      )}
    </div>
  );
}

function baggageHelper(items: readonly Baggage[]): string {
  const weighed = items.filter((item) => item.measuredWeightKg !== null);
  if (items.length === 0) return 'Aucun bagage enregistré';
  if (weighed.length === 0) return 'Aucun bagage pesé';
  const kg = weighed.reduce((total, item) => total + Number(item.measuredWeightKg), 0);
  const missing = items.length - weighed.length;
  return `${formatKg(kg)} pesés${missing ? ` · ${missing} non pesé${missing > 1 ? 's' : ''}` : ''}`;
}

function pendingValue(source: CockpitSource<unknown>): string {
  return source.state === 'error' ? 'Non disponible' : '…';
}

/**
 * Trip cockpit (OPS-TRIP-UI-1): header, KPI row, tabs. Read first, edit
 * second: every form opens only on an explicit "Modifier". Each read and
 * mutation keeps its own permission; nothing is shown without its data.
 */
export function TripDetail({
  trip,
  vehicles,
  supportVehicles,
  canManage,
  canAssignSeatMap,
  seatMapOptions,
  canReadPricing,
  canAssignPricing,
  run,
  busy,
  onReload,
  tab,
  onTabChange,
}: {
  trip: AdminTrip;
  vehicles: readonly AdminVehicle[];
  supportVehicles: readonly AdminVehicle[];
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
  tab: TripTabId;
  onTabChange: (tab: TripTabId) => void;
}) {
  const can = useCockpitPermissions();
  const data = useTripCockpitData(trip, can);
  const panelRef = useRef<HTMLDivElement>(null);
  const dangerRef = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState<TripEditTarget | null>(null);
  const [editTokens, setEditTokens] = useState({ pricing: 0, costs: 0 });
  const [cancelOpen, setCancelOpen] = useState(false);
  const byWaypoint = new Map(trip.timings.map((timing) => [timing.routeWaypointId, timing]));
  const { origin, destination } = tripEnds(trip.routeVersion.waypoints);
  const editable = canManage && trip.status === 'DRAFT';
  const costsLocked = data.costs.state === 'ready' && data.costs.data.status === 'LOCKED';
  const canCancel = canManage && trip.status !== 'CANCELLED';

  // A different trip starts read-only.
  useEffect(() => {
    setEditing(null);
    setCancelOpen(false);
  }, [trip.id]);

  useEffect(() => {
    if (cancelOpen) dangerRef.current?.focus();
  }, [cancelOpen]);

  // The manifest history is read when its tab is actually opened.
  const { request } = data;
  useEffect(() => {
    if (tab === 'documents') request('manifests');
  }, [tab, request]);

  const canEdit = (target: TripEditTarget): boolean => {
    switch (target) {
      case 'timetable':
        return editable;
      case 'vehicle':
      case 'support':
        return canManage && (trip.status === 'DRAFT' || trip.status === 'SCHEDULED');
      case 'seatMap':
        return canAssignSeatMap && trip.status === 'DRAFT';
      case 'pricing':
        return canReadPricing && canAssignPricing && trip.status === 'DRAFT';
      case 'costs':
        return canManage && trip.status !== 'CANCELLED' && !costsLocked;
    }
  };

  const openTab = (next: TripTabId) => {
    onTabChange(next);
    requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
  };

  const openEditor = (target: TripEditTarget) => {
    onTabChange(EDIT_TARGET_TAB[target]);
    if (target === 'pricing' || target === 'costs') {
      setEditTokens((current) => ({ ...current, [target]: current[target] + 1 }));
    } else {
      setEditing(target);
    }
  };

  const closeEditor = (target: TripEditTarget) => {
    setEditing(null);
    requestAnimationFrame(() => document.getElementById(`trip-edit-${target}`)?.focus());
  };

  const savedEditor = (target: TripEditTarget) => async () => {
    if (editing === target) setEditing(null);
    await onReload();
  };

  const schedule = async () => {
    if (busy) return;
    const ok = await run(
      () => auth.admin.trips.scheduleTrip(trip.id),
      `Voyage ${trip.reference} planifié.`,
    );
    if (ok) await onReload();
  };

  const alerts = tripAlerts({ trip, data, canEdit, openEditor, openTab });
  const vehicleAction = (target: 'vehicle' | 'support') => {
    if (!canEdit(target)) return null;
    const assigned = target === 'vehicle' ? trip.vehicle : trip.supportVehicle;
    return {
      verb: assigned ? ('Modifier' as const) : ('Affecter' as const),
      id: `trip-edit-${target}`,
      onClick: () => openEditor(target),
    };
  };

  const visibleTabs = TRIP_TABS.filter((candidate) => {
    switch (candidate.id) {
      case 'passagers':
        return can.bookings;
      case 'bagages':
        return can.baggage;
      case 'colis-fret':
        return can.cargo;
      case 'tarification':
        return canReadPricing;
      case 'documents':
        return can.manifests;
      default:
        return true;
    }
  });
  const selectedTab = visibleTabs.some((candidate) => candidate.id === tab) ? tab : 'apercu';

  const editMenu: CockpitMenuItem[] = (Object.keys(EDIT_TARGET_LABELS) as TripEditTarget[])
    .filter(canEdit)
    .map((target) => ({
      id: target,
      label: EDIT_TARGET_LABELS[target],
      onSelect: () => openEditor(target),
    }));
  const moreMenu: CockpitMenuItem[] = [
    ...(can.manifests
      ? [{ id: 'documents', label: 'Documents', onSelect: () => openTab('documents') }]
      : []),
    { id: 'history', label: 'Historique', onSelect: () => openTab('historique') },
    ...(canCancel
      ? [
          {
            id: 'cancel',
            label: 'Annuler le voyage…',
            danger: true,
            onSelect: () => setCancelOpen(true),
          },
        ]
      : []),
  ];

  // KPI figures: each one comes from its own source, or is not shown.
  const capacity = trip.seatMapVersion?.seatCount ?? null;
  const figures = data.bookings.state === 'ready' ? bookingFigures(data.bookings.data) : null;
  const costs = data.costs.state === 'ready' ? data.costs.data : null;
  const actuals = data.profit.state === 'ready' ? data.profit.data.financeActuals : null;
  const plannedCost = data.profit.state === 'ready' ? data.profit.data.plannedCost : null;
  const firstActual = actuals?.[0] ?? null;
  const otherCurrencies =
    actuals && actuals.length > 1
      ? ` · +${actuals.length - 1} devise${actuals.length > 2 ? 's' : ''}, sans conversion`
      : '';
  const fillRate = figures && capacity ? Math.round((figures.confirmed / capacity) * 100) : null;
  const liveCargo =
    data.cargo.state === 'ready'
      ? data.cargo.data.filter(
          (item) => item.lifecycleStatus !== 'CANCELLED' && item.lifecycleStatus !== 'REFUSED',
        )
      : null;
  const keptBaggage =
    data.baggage.state === 'ready'
      ? data.baggage.data.filter((item) => item.lifecycleStatus !== 'REMOVED')
      : null;

  return (
    <section
      aria-labelledby="trip-detail-title"
      className="et-network-panel ops-trip-cockpit"
      data-testid="trip-detail"
    >
      <header className="ops-trip-hero">
        <div className="ops-trip-hero__top">
          <div className="ops-trip-hero__identity">
            <h2 className="ops-trip-hero__title">
              <span id="trip-detail-title" className="ops-trip-hero__ref">
                Voyage {trip.reference}
              </span>
              <span className="ops-trip-hero__route">
                {origin?.code ?? trip.routeVersion.route.code}
                {destination ? (
                  <>
                    <span aria-hidden="true"> → </span>
                    <span className="et-visually-hidden"> vers </span>
                    {destination.code}
                  </>
                ) : null}
              </span>
            </h2>
            <div className="ops-trip-hero__meta">
              <OpsStatusBadge tone={tripStatusTone(trip.status)}>
                <span data-testid="trip-status">{TRIP_STATUS_LABELS[trip.status]}</span>
              </OpsStatusBadge>
              <span>
                {trip.routeVersion.route.code} — {trip.routeVersion.route.name}, version{' '}
                {trip.routeVersion.version}
              </span>
            </div>
          </div>
          {data.vehicleMedia && trip.vehicle ? (
            <MediaThumb
              className="ops-trip-hero__photo"
              renditions={data.vehicleMedia.renditions}
              alt={data.vehicleMedia.altText}
              width={480}
              focalX={data.vehicleMedia.focalX}
              focalY={data.vehicleMedia.focalY}
            />
          ) : null}
        </div>

        <div className="ops-trip-hero__journey">
          <JourneyEnd label="Départ" place={origin} at={trip.plannedDepartureAt} />
          <div className="ops-trip-hero__duration">
            <span aria-hidden="true" className="ops-trip-hero__arrow" />
            {trip.plannedDepartureAt && trip.plannedArrivalAt ? (
              <span>
                Durée prévue{' '}
                <strong>{formatDuration(trip.plannedDepartureAt, trip.plannedArrivalAt)}</strong>
              </span>
            ) : null}
          </div>
          <JourneyEnd label="Arrivée" place={destination} at={trip.plannedArrivalAt} />
        </div>

        {trip.status === 'CANCELLED' ? (
          <p className="ops-trip-hero__notice ops-trip-hero__notice--danger">
            Ce voyage est annulé : il ne peut plus être modifié.
            {trip.cancelledAt ? ` Annulation le ${formatUtc(trip.cancelledAt)}.` : ''}
          </p>
        ) : null}
        {trip.status === 'SCHEDULED' && trip.scheduledAt ? (
          <p className="ops-trip-hero__notice">
            Planifié le {formatUtc(trip.scheduledAt)} : horaire, plan de sièges et tarification sont
            figés.
          </p>
        ) : null}
        {trip.actualDepartureAt ? (
          <p className="ops-trip-hero__notice">
            Départ réel : {formatUtc(trip.actualDepartureAt)}
            {trip.actualArrivalAt ? ` · Arrivée réelle : ${formatUtc(trip.actualArrivalAt)}` : ''}
          </p>
        ) : null}

        <div className="ops-trip-hero__actions" role="group" aria-label="Actions du voyage">
          {editable ? (
            <button
              type="button"
              className="et-button"
              disabled={busy}
              aria-describedby="trip-schedule-hint"
              onClick={() => void schedule()}
            >
              Planifier le voyage
            </button>
          ) : null}
          <CockpitMenu label="Modifier" menuLabel="Modifier le voyage" items={editMenu} />
          {can.manifests ? (
            <Link
              className="et-button et-button--secondary"
              href={tripPageHref('/manifests', trip.reference)}
            >
              Manifeste
            </Link>
          ) : null}
          {can.checkIn ? (
            <Link
              className="et-button et-button--secondary"
              href={tripPageHref('/check-in', trip.reference)}
            >
              Check-in
            </Link>
          ) : null}
          {can.tracking ? (
            <Link
              className="et-button et-button--secondary"
              href={tripPageHref('/tracking', trip.reference)}
            >
              Tracking
            </Link>
          ) : null}
          <CockpitMenu label="Plus" menuLabel="Plus d’actions sur le voyage" items={moreMenu} />
        </div>
        {editable ? (
          <p className="et-hint ops-trip-hero__hint" id="trip-schedule-hint">
            La planification fige l’horaire.
          </p>
        ) : null}
      </header>

      {cancelOpen && canCancel ? (
        <section
          ref={dangerRef}
          tabIndex={-1}
          className="ops-trip-danger"
          aria-labelledby="trip-danger-title"
        >
          <div className="ops-trip-section-head">
            <h3 id="trip-danger-title">Zone sensible : annulation du voyage</h3>
            <button
              type="button"
              className="et-button et-button--secondary"
              onClick={() => setCancelOpen(false)}
            >
              Fermer la zone sensible
            </button>
          </div>
          <CancelForm
            trip={trip}
            run={run}
            busy={busy}
            onSaved={async () => {
              setCancelOpen(false);
              await onReload();
            }}
          />
        </section>
      ) : null}

      <section className="ops-trip-kpis" aria-label="Indicateurs clés">
        {can.bookings ? (
          <CockpitKpi
            label="Passagers"
            icon="users"
            value={
              figures
                ? capacity !== null
                  ? `${figures.confirmed} / ${capacity}`
                  : figures.confirmed
                : pendingValue(data.bookings)
            }
            progress={fillRate}
            helper={
              figures
                ? `${fillRate !== null ? `${fillRate} % de remplissage` : 'Aucun plan de sièges'}${
                    figures.held ? ` · ${figures.held} retenu${figures.held > 1 ? 's' : ''}` : ''
                  }`
                : undefined
            }
          />
        ) : null}
        <CockpitKpi
          label={figures && capacity !== null ? 'Sièges libres' : 'Sièges'}
          icon="seat"
          tone={capacity === null && trip.status === 'DRAFT' ? 'warning' : 'info'}
          value={
            capacity === null
              ? 'Aucun plan'
              : figures
                ? Math.max(0, capacity - figures.confirmed - figures.held)
                : capacity
          }
          helper={
            capacity === null
              ? 'Aucun plan de sièges affecté'
              : figures
                ? `sur ${capacity} · ${trip.seatMapVersion?.seatMap.code} v${trip.seatMapVersion?.version}`
                : 'Capacité du plan du voyage'
          }
        />
        {can.baggage ? (
          <CockpitKpi
            label="Bagages"
            icon="baggage"
            value={keptBaggage ? keptBaggage.length : pendingValue(data.baggage)}
            helper={keptBaggage ? baggageHelper(keptBaggage) : undefined}
          />
        ) : null}
        {can.cargo ? (
          <CockpitKpi
            label="Colis & fret"
            icon="cargo"
            value={liveCargo ? liveCargo.length : pendingValue(data.cargo)}
            helper={
              liveCargo
                ? liveCargo.length === 0
                  ? 'Aucun envoi actif'
                  : `${formatKg(liveCargo.reduce((total, item) => total + Number(item.weightKg), 0))} · ${formatCargoVolume(
                      liveCargo.reduce((total, item) => total + item.volumeLiters, 0),
                    )}`
                : undefined
            }
          />
        ) : null}
        {can.finance && data.profit.state === 'idle' ? (
          <CockpitKpi
            label="CA et marge réels"
            icon="finance"
            value="—"
            helper={
              <OnDemandButton
                label="Charger les chiffres Finance"
                onClick={() => data.request('profit')}
              />
            }
          />
        ) : null}
        {can.finance && data.profit.state !== 'idle' ? (
          <CockpitKpi
            label="CA réel"
            icon="finance"
            value={
              actuals ? (
                firstActual ? (
                  <KpiAmount
                    text={formatMinor(
                      firstActual.netRevenueMinor,
                      firstActual.currencyCode,
                      firstActual.currencyMinorUnit,
                    )}
                  />
                ) : (
                  '—'
                )
              ) : (
                pendingValue(data.profit)
              )
            }
            helper={
              actuals
                ? firstActual
                  ? `Recettes nettes Finance${otherCurrencies}`
                  : 'Aucun flux Finance'
                : undefined
            }
          />
        ) : null}
        <CockpitKpi
          label="Coûts prévus"
          icon="pricing"
          value={
            costs ? (
              costs.id !== null ? (
                <KpiAmount
                  text={formatMinor(
                    costs.totalCostMinor,
                    costs.currencyCode,
                    costs.currencyMinorUnit,
                  )}
                />
              ) : (
                '—'
              )
            ) : (
              pendingValue(data.costs)
            )
          }
          helper={
            costs
              ? costs.id !== null
                ? `Estimé · ${costStatusLabel(costs.status)}`
                : 'Aucun chiffrage enregistré'
              : undefined
          }
        />
        {can.finance && data.profit.state !== 'idle' ? (
          <CockpitKpi
            label="Marge réelle"
            icon="chart"
            tone={
              firstActual
                ? firstActual.contributionMinor.startsWith('-')
                  ? 'danger'
                  : 'success'
                : 'info'
            }
            value={
              actuals ? (
                firstActual ? (
                  <KpiAmount
                    text={formatMinor(
                      firstActual.contributionMinor,
                      firstActual.currencyCode,
                      firstActual.currencyMinorUnit,
                    )}
                  />
                ) : (
                  '—'
                )
              ) : (
                pendingValue(data.profit)
              )
            }
            helper={
              actuals
                ? firstActual
                  ? `Recettes nettes − dépenses${otherCurrencies}`
                  : 'Aucun flux Finance'
                : undefined
            }
          />
        ) : null}
      </section>

      <OpsTabs
        tabs={visibleTabs}
        selected={selectedTab}
        onSelect={(id) => onTabChange(id as TripTabId)}
        label={`Rubriques du voyage ${trip.reference}`}
        idPrefix="trip-cockpit"
        className="ops-trip-tabs"
      />

      <div
        ref={panelRef}
        role="tabpanel"
        id={`trip-cockpit-panel-${selectedTab}`}
        aria-labelledby={`trip-cockpit-tab-${selectedTab}`}
        tabIndex={-1}
        className="ops-trip-panel"
      >
        {selectedTab === 'apercu' ? (
          <TripOverview
            trip={trip}
            data={data}
            can={can}
            canReadPricing={canReadPricing}
            alerts={alerts}
            vehicleAction={vehicleAction('vehicle')}
            supportAction={vehicleAction('support')}
            openTab={openTab}
            onRequest={data.request}
          />
        ) : null}

        {selectedTab === 'itineraire' ? (
          <section aria-labelledby="trip-itinerary-title">
            <div className="ops-trip-section-head">
              <h3 id="trip-itinerary-title">Itinéraire et horaire</h3>
              {canEdit('timetable') && editing !== 'timetable' ? (
                <button
                  id="trip-edit-timetable"
                  type="button"
                  className="et-button et-button--secondary"
                  onClick={() => openEditor('timetable')}
                >
                  Modifier l’horaire
                </button>
              ) : null}
            </div>
            <RouteSchematic trip={trip} />
            {editing === 'timetable' && canEdit('timetable') ? (
              <EditorFrame
                label="Modification de l’horaire"
                onClose={() => closeEditor('timetable')}
              >
                <TimetableEditor
                  trip={trip}
                  run={run}
                  busy={busy}
                  onSaved={savedEditor('timetable')}
                />
              </EditorFrame>
            ) : (
              <div className="et-table-wrap">
                <table className="et-table">
                  <caption>{`Horaire du voyage ${trip.reference} (UTC)`}</caption>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Point</th>
                      <th scope="col">Montée / descente</th>
                      <th scope="col">Arrivée</th>
                      <th scope="col">Départ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trip.routeVersion.waypoints.map((waypoint) => {
                      const place = placeOf(waypoint);
                      const timing = byWaypoint.get(waypoint.id);
                      const localOf = (value: string | null | undefined) =>
                        value ? formatLocalTime(value, place.timezone) : null;
                      const arrivalLocal = localOf(timing?.plannedArrivalAt);
                      const departureLocal = localOf(timing?.plannedDepartureAt);
                      return (
                        <tr key={waypoint.id}>
                          <td>{waypoint.sequence}</td>
                          <th scope="row">
                            {place.kind} {place.code} — {place.name}
                          </th>
                          <td>
                            {waypoint.stop
                              ? [
                                  waypoint.boardingAllowed ? 'Montée' : null,
                                  waypoint.alightingAllowed ? 'Descente' : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ') || '—'
                              : 'Passage'}
                          </td>
                          <td>
                            {formatUtc(timing?.plannedArrivalAt ?? null)}
                            {arrivalLocal ? <small>{`Heure locale ${arrivalLocal}`}</small> : null}
                          </td>
                          <td>
                            {formatUtc(timing?.plannedDepartureAt ?? null)}
                            {departureLocal ? (
                              <small>{`Heure locale ${departureLocal}`}</small>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {trip.status !== 'DRAFT' ? (
              <p className="et-hint">L’horaire est figé depuis la planification.</p>
            ) : null}
            {trip.routeVersion.status === 'RETIRED' ? (
              <p className="et-hint">
                La version de route a été retirée depuis ; le voyage reste valide.
              </p>
            ) : null}
          </section>
        ) : null}

        {selectedTab === 'passagers' ? (
          <PassengersPanel trip={trip} data={data} can={can} onRetry={data.reload} />
        ) : null}
        {selectedTab === 'bagages' ? (
          <BaggagePanel trip={trip} data={data} onRetry={data.reload} />
        ) : null}
        {selectedTab === 'colis-fret' ? (
          <CargoPanel trip={trip} data={data} onRetry={data.reload} />
        ) : null}

        {selectedTab === 'tarification' && canReadPricing ? (
          <TripPricingPanel
            trip={trip}
            canAssign={canAssignPricing}
            run={run}
            busy={busy}
            onReload={onReload}
            editToken={editTokens.pricing}
          />
        ) : null}

        {selectedTab === 'couts' ? (
          <div className="ops-trip-stack">
            <TripCostPanel
              tripId={trip.id}
              tripReference={trip.reference}
              canManage={canManage && trip.status !== 'CANCELLED'}
              run={run}
              busy={busy}
              onSaved={onReload}
              editToken={editTokens.costs}
            />
            {can.finance && data.profit.state === 'idle' ? (
              <section className="ops-trip-card" aria-labelledby="trip-budget-title">
                <h3 id="trip-budget-title">Budget prévu et dépenses réelles</h3>
                <p className="et-hint">
                  Le réalisé Finance est une lecture auditée : il n’est chargé qu’à la demande.
                </p>
                <OnDemandButton
                  label="Comparer au réalisé Finance"
                  onClick={() => data.request('profit')}
                />
              </section>
            ) : null}
            {can.finance && data.profit.state === 'ready' ? (
              <section className="ops-trip-card" aria-labelledby="trip-budget-title">
                <div className="ops-trip-section-head">
                  <h3 id="trip-budget-title">Budget prévu et dépenses réelles</h3>
                  <Link className="ops-trip-link" href="/finance">
                    Analyse complète dans Finance
                  </Link>
                </div>
                {plannedCost ? (
                  <dl className="ops-trip-summary">
                    {(
                      [
                        ['Budget prévu', plannedCost.plannedCostMinor],
                        ['Dépenses réelles', plannedCost.actualExpenseMinor],
                        ['Écart', plannedCost.varianceMinor],
                        ['Budget restant', plannedCost.remainingBudgetMinor],
                      ] as const
                    ).map(([label, amount]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>
                          {formatMinor(
                            amount,
                            plannedCost.currencyCode,
                            plannedCost.currencyMinorUnit,
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="et-hint">Aucun budget prévisionnel disponible.</p>
                )}
                <p className="et-hint">Un écart positif signifie un dépassement du budget.</p>
              </section>
            ) : null}
          </div>
        ) : null}

        {selectedTab === 'vehicules' ? (
          <section className="ops-trip-stack" aria-labelledby="trip-vehicles-title">
            <h3 id="trip-vehicles-title" className="et-visually-hidden">
              Véhicules du voyage
            </h3>
            <div className="ops-trip-vehicles">
              <div className="ops-trip-stack">
                <VehicleCard
                  kind="principal"
                  vehicle={trip.vehicle}
                  media={data.vehicleMedia}
                  seatCount={capacity}
                  action={editing === 'vehicle' ? null : vehicleAction('vehicle')}
                />
                {editing === 'vehicle' && canEdit('vehicle') ? (
                  <EditorFrame
                    label="Modification du véhicule principal"
                    onClose={() => closeEditor('vehicle')}
                  >
                    <VehicleForm
                      trip={trip}
                      vehicles={vehicles}
                      run={run}
                      busy={busy}
                      onSaved={savedEditor('vehicle')}
                    />
                  </EditorFrame>
                ) : null}
              </div>
              <div className="ops-trip-stack">
                <VehicleCard
                  kind="support"
                  vehicle={trip.supportVehicle}
                  media={data.supportVehicleMedia}
                  action={editing === 'support' ? null : vehicleAction('support')}
                />
                {editing === 'support' && canEdit('support') ? (
                  <EditorFrame
                    label="Modification du véhicule d’appoint"
                    onClose={() => closeEditor('support')}
                  >
                    <SupportVehicleForm
                      trip={trip}
                      vehicles={supportVehicles}
                      run={run}
                      busy={busy}
                      onSaved={savedEditor('support')}
                    />
                  </EditorFrame>
                ) : null}
              </div>
            </div>
            {canManage && !canEdit('vehicle') ? (
              <p className="et-hint">
                Les véhicules ne se modifient que sur un voyage en brouillon ou planifié.
              </p>
            ) : null}
            <TripSeatMapPanel
              trip={trip}
              canAssign={canAssignSeatMap}
              options={seatMapOptions}
              run={run}
              busy={busy}
              onReload={onReload}
              editing={editing === 'seatMap'}
              onEdit={() => openEditor('seatMap')}
              onClose={() => closeEditor('seatMap')}
            />
          </section>
        ) : null}

        {selectedTab === 'documents' ? (
          <DocumentsPanel trip={trip} data={data} onRetry={data.reload} />
        ) : null}

        {selectedTab === 'historique' ? (
          <section aria-labelledby="trip-history-title">
            <h3 id="trip-history-title">Historique</h3>
            <TripHistoryList trip={trip} label={`Historique du voyage ${trip.reference}`} />
          </section>
        ) : null}
      </div>
    </section>
  );
}
