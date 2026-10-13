'use client';

import type { AdminTrip, ResolvedTripFare } from '@euroteranga/auth-client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import type { useAdminFeedback } from '../admin/admin-feedback';
import { placeOf } from '../trips/trip-format';
import {
  assignedFareLabel,
  fareDestinations,
  fareOrigins,
  faresLabel,
  money,
} from './pricing-format';

type Run = ReturnType<typeof useAdminFeedback>['run'];

interface FareOption {
  id: string;
  label: string;
}

/**
 * PUBLISHED versions of active fare tables pricing exactly the trip's route
 * version: the only ones the API accepts for a new assignment.
 */
function useCompatibleFareVersions(trip: AdminTrip, enabled: boolean): FareOption[] {
  const [options, setOptions] = useState<FareOption[]>([]);
  const routeId = trip.routeVersion.route.id;
  const routeVersionId = trip.routeVersionId;
  useEffect(() => {
    if (!enabled) return;
    void auth.admin.pricing.fareTables({ active: true, routeId, limit: 100 }).then((result) => {
      if (!result.ok) return;
      setOptions(
        result.data.items.flatMap((table) =>
          table.versions
            .filter(
              (version) =>
                version.status === 'PUBLISHED' && version.routeVersionId === routeVersionId,
            )
            .map((version) => ({
              id: version.id,
              label: `${table.code} v${version.version} (${table.currencyCode}) — ${faresLabel(version.entryCount)}`,
            })),
        ),
      );
    });
  }, [enabled, routeId, routeVersionId]);
  return options;
}

const stopLabel = (waypoint: AdminTrip['routeVersion']['waypoints'][number]) => {
  const place = placeOf(waypoint);
  return `${waypoint.sequence}. ${place.code} — ${place.name}`;
};

/** Server-side resolution of one base fare of the trip (no quote, no booking). */
function FarePreview({ trip }: { trip: AdminTrip }) {
  const originId = useId();
  const destinationId = useId();
  const waypoints = trip.routeVersion.waypoints;
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [result, setResult] = useState<ResolvedTripFare | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const origins = fareOrigins(waypoints);
  const destinations = fareDestinations(
    waypoints,
    waypoints.find((waypoint) => waypoint.id === origin),
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!origin || !destination || pending) return;
    setPending(true);
    const response = await auth.admin.trips.resolveTripFare(trip.id, origin, destination);
    setPending(false);
    if (response.ok) {
      setResult(response.data);
      setMessage(null);
    } else {
      setResult(null);
      setMessage(response.error.message);
    }
  };
  return (
    <form className="et-form et-network-form" aria-label="Aperçu d’un tarif" onSubmit={submit}>
      <h4>Aperçu d’un tarif de base</h4>
      <div className="et-field">
        <label htmlFor={originId}>Origine du trajet</label>
        <select
          id={originId}
          className="et-select"
          value={origin}
          onChange={(event) => {
            setOrigin(event.target.value);
            setDestination('');
            setResult(null);
          }}
        >
          <option value="">Choisir une origine</option>
          {origins.map((waypoint) => (
            <option key={waypoint.id} value={waypoint.id}>
              {stopLabel(waypoint)}
            </option>
          ))}
        </select>
      </div>
      <div className="et-field">
        <label htmlFor={destinationId}>Destination du trajet</label>
        <select
          id={destinationId}
          className="et-select"
          value={destination}
          disabled={!origin}
          onChange={(event) => {
            setDestination(event.target.value);
            setResult(null);
          }}
        >
          <option value="">Choisir une destination</option>
          {destinations.map((waypoint) => (
            <option key={waypoint.id} value={waypoint.id}>
              {stopLabel(waypoint)}
            </option>
          ))}
        </select>
      </div>
      <button
        className="et-button et-button--secondary"
        type="submit"
        disabled={pending || !destination}
      >
        Calculer le tarif
      </button>
      {result ? (
        <p role="status">
          Tarif de base :{' '}
          <output data-testid="trip-fare-preview">
            {money(result.amountMinor, result.currencyCode, result.currencyMinorUnit)}
          </output>{' '}
          (grille {result.fareTableCode} v{result.fareTableVersion})
        </p>
      ) : null}
      {message ? (
        <p className="et-error" role="status" data-testid="trip-fare-preview-error">
          {message}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Historical pricing of a trip (pricing.read to see it). A DRAFT trip may be
 * priced with a compatible PUBLISHED version by trip.manage + pricing.read
 * holders; the current value is sent as the expected state. Frozen once
 * SCHEDULED or CANCELLED.
 */
export function TripPricingPanel({
  trip,
  canAssign,
  run,
  busy,
  onReload,
}: {
  trip: AdminTrip;
  /** trip.manage + pricing.read. */
  canAssign: boolean;
  run: Run;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  const selectId = useId();
  const editable = canAssign && trip.status === 'DRAFT';
  const options = useCompatibleFareVersions(trip, editable);
  const current = trip.fareTableVersion;
  const [value, setValue] = useState('');
  useEffect(() => {
    setValue(trip.fareTableVersionId ?? '');
  }, [trip.fareTableVersionId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next = value || null;
    const label = next
      ? (options.find((option) => option.id === next)?.label ?? assignedFareLabel(current))
      : 'aucune';
    const ok = await run(
      () =>
        auth.admin.trips.assignTripFareTable(trip.id, {
          fareTableVersionId: next,
          expectedFareTableVersionId: trip.fareTableVersionId,
        }),
      `Tarification du voyage ${trip.reference} : ${label}.`,
    );
    if (ok) await onReload();
  };

  return (
    <section aria-labelledby="trip-pricing-title">
      <h3 id="trip-pricing-title">Tarification</h3>
      <p>
        Grille du voyage :{' '}
        <strong data-testid="trip-fare-table">{assignedFareLabel(current)}</strong>
      </p>
      {current && !current.fareTable.active ? (
        <p className="et-hint">
          La grille a été désactivée depuis ; le voyage conserve sa version.
        </p>
      ) : null}
      {trip.status !== 'DRAFT' ? (
        <p className="et-hint">
          La tarification est figée : elle fait partie de l’historique du voyage.
        </p>
      ) : null}
      {editable ? (
        <form
          className="et-form et-network-form"
          aria-label={`Tarification du voyage ${trip.reference}`}
          onSubmit={submit}
        >
          <div className="et-field">
            <label htmlFor={selectId}>Grille tarifaire du voyage</label>
            <select
              id={selectId}
              className="et-select"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            >
              <option value="">Aucune grille</option>
              {current && !options.some((option) => option.id === current.id) ? (
                <option value={current.id}>{`${assignedFareLabel(current)} (actuelle)`}</option>
              ) : null}
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="et-hint">
              Seules les versions publiées des grilles actives tarifant cette version de route sont
              proposées. La tarification reste facultative pour planifier.
            </p>
          </div>
          <button className="et-button" type="submit" disabled={busy}>
            Enregistrer la tarification
          </button>
        </form>
      ) : null}
      {current ? <FarePreview trip={trip} /> : null}
    </section>
  );
}
