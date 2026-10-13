'use client';

import {
  parseMoneyToMinor,
  type AdminFareTable,
  type AdminFareTableVersion,
} from '@euroteranga/auth-client';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import type { useAdminFeedback } from '../admin/admin-feedback';
import { fareDestinations, fareOrigins, faresLabel, money, placeLabel } from './pricing-format';

type Run = ReturnType<typeof useAdminFeedback>['run'];

interface EditorFare {
  originRouteWaypointId: string;
  destinationRouteWaypointId: string;
  amountMinor: number;
}

const pairKey = (fare: Pick<EditorFare, 'originRouteWaypointId' | 'destinationRouteWaypointId'>) =>
  `${fare.originRouteWaypointId}>${fare.destinationRouteWaypointId}`;

function sortFares(fares: EditorFare[], order: Map<string, number>) {
  return [...fares].sort(
    (a, b) =>
      (order.get(a.originRouteWaypointId) ?? 0) - (order.get(b.originRouteWaypointId) ?? 0) ||
      (order.get(a.destinationRouteWaypointId) ?? 0) -
        (order.get(b.destinationRouteWaypointId) ?? 0),
  );
}

/** Read-only fare matrix of one version (any status). */
export function FareEntriesTable({
  fareTable,
  version,
  caption,
}: {
  fareTable: Pick<AdminFareTable, 'currencyCode' | 'currencyMinorUnit'>;
  version: AdminFareTableVersion;
  caption: string;
}) {
  const byId = new Map(version.routeVersion.waypoints.map((waypoint) => [waypoint.id, waypoint]));
  const order = new Map(version.routeVersion.waypoints.map((w) => [w.id, w.sequence]));
  const fares = sortFares(version.entries, order);
  if (fares.length === 0) return <p>Aucun tarif.</p>;
  return (
    <div className="et-table-wrap">
      <table className="et-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Origine</th>
            <th scope="col">Destination</th>
            <th scope="col">Tarif de base</th>
          </tr>
        </thead>
        <tbody>
          {fares.map((fare) => {
            const origin = byId.get(fare.originRouteWaypointId);
            const destination = byId.get(fare.destinationRouteWaypointId);
            return (
              <tr key={pairKey(fare)}>
                <th scope="row">{origin ? placeLabel(origin) : '?'}</th>
                <td>{destination ? placeLabel(destination) : '?'}</td>
                <td>
                  {money(fare.amountMinor, fareTable.currencyCode, fareTable.currencyMinorUnit)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Editing of a DRAFT fare matrix: each origin/destination pair is priced
 * explicitly (no interpolation). Amounts are converted to exact minor units
 * with parseMoneyToMinor; the complete matrix is saved in one atomic
 * replacement, and publication uses the saved matrix only. The API is the
 * authority and re-validates everything.
 */
export function FareDraftEditor({
  fareTable,
  draft,
  run,
  busy,
  onSaved,
}: {
  fareTable: AdminFareTable;
  draft: AdminFareTableVersion;
  run: Run;
  busy: boolean;
  onSaved: () => Promise<void>;
}) {
  const originId = useId();
  const destinationId = useId();
  const amountId = useId();
  const waypoints = draft.routeVersion.waypoints;
  const order = useMemo(() => new Map(waypoints.map((w) => [w.id, w.sequence])), [waypoints]);
  const byId = useMemo(() => new Map(waypoints.map((w) => [w.id, w])), [waypoints]);
  const savedFares = useMemo(
    () =>
      sortFares(
        draft.entries.map(({ originRouteWaypointId, destinationRouteWaypointId, amountMinor }) => ({
          originRouteWaypointId,
          destinationRouteWaypointId,
          amountMinor,
        })),
        order,
      ),
    [draft, order],
  );
  const [fares, setFares] = useState<EditorFare[]>([]);
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setFares(savedFares);
  }, [savedFares]);

  const origins = fareOrigins(waypoints);
  const destinations = fareDestinations(waypoints, byId.get(origin));
  const dirty = JSON.stringify(fares) !== JSON.stringify(savedFares);
  const unit = fareTable.currencyMinorUnit;

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!origin || !destination) {
      setLocalError('Choisissez une origine et une destination.');
      return;
    }
    const amountMinor = parseMoneyToMinor(amount, unit);
    if (amountMinor === null) {
      setLocalError(
        unit === 0
          ? `Montant invalide : un nombre entier strictement positif de ${fareTable.currencyCode}.`
          : `Montant invalide : strictement positif, au plus ${unit} décimale${unit > 1 ? 's' : ''}.`,
      );
      return;
    }
    const next = {
      originRouteWaypointId: origin,
      destinationRouteWaypointId: destination,
      amountMinor,
    };
    if (fares.some((fare) => pairKey(fare) === pairKey(next))) {
      setLocalError('Cette paire est déjà tarifée : retirez-la avant de la modifier.');
      return;
    }
    setLocalError(null);
    setFares(sortFares([...fares, next], order));
    setAmount('');
  };

  const save = async () => {
    if (busy) return;
    const ok = await run(
      () => auth.admin.pricing.replaceFares(fareTable.id, draft.id, { fares }),
      `Grille du brouillon version ${draft.version} enregistrée (${faresLabel(fares.length)}).`,
    );
    if (ok) await onSaved();
  };
  const publish = async () => {
    if (busy || dirty) return;
    const ok = await run(
      () => auth.admin.pricing.publishVersion(fareTable.id, draft.id),
      `Version ${draft.version} de la grille ${fareTable.code} publiée.`,
    );
    if (ok) await onSaved();
  };

  return (
    <section aria-labelledby="fare-editor-title" className="et-network-panel">
      <h3 id="fare-editor-title">
        Brouillon version {draft.version} — route version {draft.routeVersion.version}
      </h3>
      <p className="et-hint">
        Montants en {fareTable.currencyCode} ({unit} décimale{unit > 1 ? 's' : ''}). Les tarifs sont
        définis entre arrêts : origine autorisant la montée, destination autorisant la descente et
        située après l’origine. Une paire absente n’a pas de tarif.
      </p>
      <form className="et-form et-network-form" aria-label="Ajouter un tarif" onSubmit={add}>
        <div className="et-field">
          <label htmlFor={originId}>Origine</label>
          <select
            id={originId}
            className="et-select"
            value={origin}
            onChange={(event) => {
              setOrigin(event.target.value);
              setDestination('');
            }}
          >
            <option value="">Choisir une origine</option>
            {origins.map((waypoint) => (
              <option key={waypoint.id} value={waypoint.id}>
                {placeLabel(waypoint)}
              </option>
            ))}
          </select>
        </div>
        <div className="et-field">
          <label htmlFor={destinationId}>Destination</label>
          <select
            id={destinationId}
            className="et-select"
            value={destination}
            disabled={!origin}
            onChange={(event) => setDestination(event.target.value)}
          >
            <option value="">Choisir une destination</option>
            {destinations.map((waypoint) => (
              <option key={waypoint.id} value={waypoint.id}>
                {placeLabel(waypoint)}
              </option>
            ))}
          </select>
        </div>
        <div className="et-field">
          <label htmlFor={amountId}>{`Tarif de base (${fareTable.currencyCode})`}</label>
          <input
            id={amountId}
            className="et-input"
            inputMode={unit === 0 ? 'numeric' : 'decimal'}
            autoComplete="off"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <p className="et-hint">{unit === 0 ? 'Exemple : 15000' : 'Exemple : 123,45'}</p>
        </div>
        {localError ? (
          <p className="et-error" role="status">
            {localError}
          </p>
        ) : null}
        <button className="et-button et-button--secondary" type="submit" disabled={busy}>
          Ajouter le tarif
        </button>
      </form>

      {fares.length > 0 ? (
        <div className="et-table-wrap">
          <table className="et-table">
            <caption>{`Tarifs du brouillon version ${draft.version}`}</caption>
            <thead>
              <tr>
                <th scope="col">Origine</th>
                <th scope="col">Destination</th>
                <th scope="col">Tarif de base</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {fares.map((fare) => {
                const from = byId.get(fare.originRouteWaypointId);
                const to = byId.get(fare.destinationRouteWaypointId);
                const label = `${from ? placeLabel(from) : '?'} → ${to ? placeLabel(to) : '?'}`;
                return (
                  <tr key={pairKey(fare)}>
                    <th scope="row">{from ? placeLabel(from) : '?'}</th>
                    <td>{to ? placeLabel(to) : '?'}</td>
                    <td>{money(fare.amountMinor, fareTable.currencyCode, unit)}</td>
                    <td>
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        aria-label={`Retirer le tarif ${label}`}
                        onClick={() =>
                          setFares(
                            fares.filter((candidate) => pairKey(candidate) !== pairKey(fare)),
                          )
                        }
                      >
                        Retirer
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p>Aucun tarif dans ce brouillon.</p>
      )}

      <div className="et-actions">
        <button
          type="button"
          className="et-button"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          Enregistrer la grille
        </button>
        <button
          type="button"
          className="et-button"
          disabled={busy || dirty || savedFares.length === 0}
          onClick={() => void publish()}
        >
          Publier la version {draft.version}
        </button>
      </div>
      {dirty ? (
        <p className="et-hint">Modifications non enregistrées : enregistrez avant de publier.</p>
      ) : null}
      {!dirty && savedFares.length === 0 ? (
        <p className="et-hint">Une version publiée doit contenir au moins un tarif.</p>
      ) : null}
    </section>
  );
}
