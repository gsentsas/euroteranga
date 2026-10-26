'use client';

import type { AdminTrip, PublicMedia } from '@euroteranga/auth-client';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { STATUS_LABELS as VEHICLE_STATUS_LABELS, vehicleStatusTone } from '../fleet/fleet-admin';
import { MediaThumb } from '../media/media-shared';
import { OpsIcon, type OpsIconName } from '../ops-icons';
import { OpsStatusBadge } from '../ops-ui';
import {
  formatCargoVolume,
  formatUtc,
  isAccessEvent,
  placeOf,
  TRIP_ACTION_LABELS,
  TRIP_COST_STATUS_LABELS,
  TRIP_STATUS_LABELS,
  vehicleIdentity,
  type TripTone,
} from './trip-format';

export interface CockpitMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * Menu button (WAI-ARIA pattern): arrows move between items, Escape closes
 * and gives the focus back to the button, a click outside closes.
 */
export function CockpitMenu({
  label,
  menuLabel,
  items,
}: {
  label: string;
  menuLabel: string;
  items: readonly CockpitMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Opens towards the side with room: actions wrap differently on each width.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !listRef.current) return;
    const button = buttonRef.current.getBoundingClientRect();
    const width = listRef.current.offsetWidth;
    setAlignEnd(button.left + width > document.documentElement.clientWidth - 8);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => entries[(next + entries.length) % entries.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusAt(entries.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  if (items.length === 0) return null;
  return (
    <div className="ops-trip-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="et-button et-button--secondary ops-trip-menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {label}
        <OpsIcon name="chevron" className="ops-trip-menu__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={listRef}
          id={menuId}
          role="menu"
          aria-label={menuLabel}
          className={`ops-trip-menu__list${alignEnd ? ' ops-trip-menu__list--end' : ''}`}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={item.danger ? 'ops-trip-menu__item--danger' : undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect();
                // An item that does not move the focus itself gives it back to the button.
                requestAnimationFrame(() => {
                  if (document.activeElement === document.body) buttonRef.current?.focus();
                });
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One figure of the KPI row; `progress` (0–100) draws a filling bar. */
export function CockpitKpi({
  label,
  value,
  helper,
  icon,
  tone = 'info',
  progress,
}: {
  label: string;
  value: ReactNode;
  helper?: ReactNode;
  icon: OpsIconName;
  tone?: TripTone;
  progress?: number | null;
}) {
  return (
    <article className="ops-trip-kpi">
      <div className="ops-trip-kpi__head">
        <span className={`ops-trip-kpi__icon ops-trip-kpi__icon--${tone}`} aria-hidden="true">
          <OpsIcon name={icon} />
        </span>
        <span className="ops-trip-kpi__label">{label}</span>
      </div>
      <strong className="ops-trip-kpi__value">{value}</strong>
      {progress !== undefined && progress !== null ? (
        <span className="ops-trip-kpi__bar" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </span>
      ) : null}
      {helper ? <small>{helper}</small> : null}
    </article>
  );
}

/** "7 968,00 EUR" with a lighter currency code, so amounts fit narrow KPI cards. */
export function KpiAmount({ text }: { text: string }) {
  const space = text.lastIndexOf(' ');
  if (space < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, space)}
      <span className="ops-trip-kpi__unit">{text.slice(space)}</span>
    </>
  );
}

/**
 * Schematic only: the trip API exposes no coordinates. Points are placed by
 * planned time when the whole timetable is known, evenly otherwise; only the
 * stops are labelled (checkpoint codes would collide). Purely visual
 * (aria-hidden): the ordered list or table next to it carries the data.
 */
export function RouteSchematic({ trip, compact = false }: { trip: AdminTrip; compact?: boolean }) {
  const waypoints = trip.routeVersion.waypoints;
  const byWaypoint = new Map(trip.timings.map((timing) => [timing.routeWaypointId, timing]));
  const instants = waypoints.map((waypoint, index) => {
    const timing = byWaypoint.get(waypoint.id);
    const value =
      index === 0
        ? timing?.plannedDepartureAt
        : (timing?.plannedArrivalAt ?? timing?.plannedDepartureAt);
    return value ? new Date(value).getTime() : null;
  });
  const first = instants[0];
  const last = instants.at(-1);
  const timed =
    first != null &&
    last != null &&
    last > first &&
    instants.every(
      (instant, index) =>
        instant !== null && (index === 0 || instant >= (instants[index - 1] ?? instant)),
    );
  const position = (index: number) =>
    timed && first != null && last != null
      ? (((instants[index] ?? first) - first) / (last - first)) * 100
      : waypoints.length > 1
        ? (index / (waypoints.length - 1)) * 100
        : 0;

  return (
    <div
      className={`ops-trip-schematic${compact ? ' ops-trip-schematic--compact' : ''}`}
      aria-hidden="true"
    >
      <div className="ops-trip-schematic__track">
        <span className="ops-trip-schematic__line" />
        {waypoints.map((waypoint, index) => {
          const place = placeOf(waypoint);
          const edge = index === 0 ? 'start' : index === waypoints.length - 1 ? 'end' : 'middle';
          return (
            <span
              key={waypoint.id}
              className={`ops-trip-schematic__point ops-trip-schematic__point--${
                waypoint.stop ? 'stop' : 'checkpoint'
              } ops-trip-schematic__point--${edge}`}
              style={{ left: `${position(index)}%` }}
              title={`${place.code} — ${place.name}`}
            >
              <i />
              {waypoint.stop ? (
                <b>
                  {place.code}
                  <small>{place.name}</small>
                </b>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Compact ordered list of the waypoints with their planned UTC time. */
export function RouteStops({ trip }: { trip: AdminTrip }) {
  const byWaypoint = new Map(trip.timings.map((timing) => [timing.routeWaypointId, timing]));
  const waypoints = trip.routeVersion.waypoints;
  return (
    <ol className="ops-trip-stops" aria-label={`Points de passage du voyage ${trip.reference}`}>
      {waypoints.map((waypoint, index) => {
        const place = placeOf(waypoint);
        const timing = byWaypoint.get(waypoint.id);
        const time =
          index === 0
            ? (timing?.plannedDepartureAt ?? null)
            : (timing?.plannedArrivalAt ?? timing?.plannedDepartureAt ?? null);
        return (
          <li
            key={waypoint.id}
            className={waypoint.stop ? 'ops-trip-stops__stop' : 'ops-trip-stops__checkpoint'}
          >
            <span className="ops-trip-stops__dot" aria-hidden="true" />
            <span className="ops-trip-stops__name">
              {place.name}
              <small>{`${place.kind} · ${place.code}`}</small>
            </span>
            <span className="ops-trip-stops__time">
              {index === 0 ? 'Départ ' : index === waypoints.length - 1 ? 'Arrivée ' : ''}
              {formatUtc(time)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

type TripVehicle = NonNullable<AdminTrip['vehicle']>;
type TripSupportVehicle = NonNullable<AdminTrip['supportVehicle']>;

export interface VehicleCardAction {
  /** Visible verb; the accessible name adds the vehicle role. */
  verb: 'Modifier' | 'Affecter';
  /** Lets the focus come back to the button when its editor closes. */
  id: string;
  onClick: () => void;
}

/** Principal or support vehicle of the trip, read-only, with an optional edit entry. */
export function VehicleCard({
  kind,
  vehicle,
  media,
  seatCount,
  action,
}: {
  kind: 'principal' | 'support';
  vehicle: TripVehicle | TripSupportVehicle | null;
  media: PublicMedia | null;
  /** Seats of the plan frozen on the trip (principal vehicle only). */
  seatCount?: number | null;
  action?: VehicleCardAction | null;
}) {
  const title = kind === 'principal' ? 'Véhicule principal' : 'Véhicule d’appoint';
  const roleLabel = kind === 'principal' ? ' le véhicule principal' : ' le véhicule d’appoint';
  const support = kind === 'support' && vehicle && 'payloadCapacityKg' in vehicle ? vehicle : null;
  return (
    <article className={`ops-trip-vehicle${vehicle ? '' : ' ops-trip-vehicle--empty'}`}>
      <div className="ops-trip-vehicle__head">
        <h4>{title}</h4>
        {action ? (
          <button
            id={action.id}
            type="button"
            className="et-button et-button--secondary ops-trip-vehicle__action"
            onClick={action.onClick}
          >
            {action.verb === 'Affecter' ? <span aria-hidden="true">+ </span> : null}
            {action.verb}
            <span className="et-visually-hidden">
              {action.verb === 'Affecter'
                ? kind === 'principal'
                  ? ' un véhicule principal'
                  : ' un véhicule d’appoint'
                : roleLabel}
            </span>
          </button>
        ) : null}
      </div>
      {media && vehicle ? (
        <MediaThumb
          className="ops-trip-vehicle__photo"
          renditions={media.renditions}
          alt={media.altText}
          width={480}
          focalX={media.focalX}
          focalY={media.focalY}
        />
      ) : null}
      <div
        className="ops-trip-vehicle__body"
        data-testid={kind === 'principal' ? 'trip-vehicle' : 'trip-support-vehicle'}
      >
        {vehicle ? (
          <>
            <strong>{vehicleIdentity(vehicle)}</strong>
            <span>
              {' — '}
              {vehicle.manufacturer} {vehicle.model}
            </span>
            {support ? (
              <span className="ops-trip-vehicle__capacity">
                {` · ${support.payloadCapacityKg ?? '—'} kg · ${formatCargoVolume(support.cargoVolumeLiters)}`}
              </span>
            ) : null}
          </>
        ) : kind === 'principal' ? (
          'Aucun'
        ) : (
          'Aucun véhicule d’appoint'
        )}
      </div>
      {vehicle ? (
        <div className="ops-trip-vehicle__facts">
          <OpsStatusBadge tone={vehicleStatusTone(vehicle.status)}>
            {VEHICLE_STATUS_LABELS[vehicle.status]}
          </OpsStatusBadge>
          {kind === 'principal' && seatCount ? (
            <span>
              <OpsIcon name="seat" aria-hidden="true" /> {seatCount} sièges sur le plan du voyage
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

type HistoryEntry = AdminTrip['history'][number];

const HISTORY_TONES: Partial<Record<string, TripTone>> = {
  TRIP_CREATED: 'neutral',
  TRIP_SCHEDULED: 'info',
  TRIP_CANCELLED: 'danger',
  TRIP_DEPARTED: 'warning',
  TRIP_COMPLETED: 'success',
};

/** "Annulation (Planifié → Annulé) — motif": the wording of the original history list. */
export function historySummary(entry: HistoryEntry): string {
  // A cost update records the cost plan's status, not the trip's.
  const statusLabels: Record<string, string> =
    entry.action === 'TRIP_COST_UPDATED' ? TRIP_COST_STATUS_LABELS : TRIP_STATUS_LABELS;
  const transitions =
    (entry.toStatus && entry.fromStatus && entry.toStatus !== entry.fromStatus
      ? ` (${statusLabels[entry.fromStatus] ?? entry.fromStatus} → ${
          statusLabels[entry.toStatus] ?? entry.toStatus
        })`
      : '') +
    (entry.action === 'TRIP_VEHICLE_CHANGED'
      ? ` (${entry.fromVehicleCode ?? 'aucun'} → ${entry.toVehicleCode ?? 'aucun'})`
      : '') +
    (entry.action === 'TRIP_SUPPORT_VEHICLE_CHANGED'
      ? ` (${entry.fromSupportVehicleCode ?? 'aucun'} → ${entry.toSupportVehicleCode ?? 'aucun'})`
      : '') +
    (entry.action === 'TRIP_SEAT_MAP_CHANGED'
      ? ` (${entry.fromSeatMap ?? 'aucun'} → ${entry.toSeatMap ?? 'aucun'})`
      : '') +
    (entry.action === 'TRIP_FARE_TABLE_CHANGED'
      ? ` (${entry.fromFareTable ?? 'aucune'} → ${entry.toFareTable ?? 'aucune'})`
      : '');
  return `${TRIP_ACTION_LABELS[entry.action] ?? entry.action}${transitions}${
    entry.reason ? ` — ${entry.reason}` : ''
  }`;
}

/**
 * Audit timeline of the trip, most recent first (API order). No actor is
 * exposed. Audited consultations (Finance, profitability, departure
 * readiness) are kept out of the way and shown on request.
 */
export function TripHistoryList({
  trip,
  limit,
  label,
}: {
  trip: AdminTrip;
  /** Short excerpt (overview): business events only, no toggle. */
  limit?: number;
  label: string;
}) {
  const [showAccess, setShowAccess] = useState(false);
  const business = trip.history.filter((entry) => !isAccessEvent(entry.action));
  const accessCount = trip.history.length - business.length;
  const source = showAccess && !limit ? trip.history : business;
  const entries = limit ? source.slice(0, limit) : source;
  return (
    <>
      {entries.length === 0 ? (
        <p className="et-hint">Aucun événement enregistré.</p>
      ) : (
        <ol className="ops-trip-history" aria-label={label}>
          {entries.map((entry) => (
            <li
              key={`${entry.occurredAt}-${entry.action}`}
              className={`ops-trip-history__item ops-trip-history__item--${
                isAccessEvent(entry.action) ? 'access' : (HISTORY_TONES[entry.action] ?? 'neutral')
              }`}
            >
              <time dateTime={entry.occurredAt}>{formatUtc(entry.occurredAt)}</time>
              <span>{historySummary(entry)}</span>
            </li>
          ))}
        </ol>
      )}
      {!limit && accessCount > 0 ? (
        <button
          type="button"
          className="ops-trip-link"
          aria-pressed={showAccess}
          onClick={() => setShowAccess((current) => !current)}
        >
          {showAccess
            ? 'Masquer les consultations auditées'
            : `Afficher les consultations auditées (${accessCount})`}
        </button>
      ) : null}
    </>
  );
}
