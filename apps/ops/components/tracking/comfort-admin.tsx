'use client';

import type {
  AdminComfortProjection,
  AdminComfortStep,
  ComfortFacility,
  ComfortWaypointStatus,
  TrackingTripDetail,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '../../lib/auth';
import { useCan } from '../staff-access';

type ComfortEventType = Exclude<ComfortWaypointStatus, 'PLANNED'>;

const STATUS_LABELS: Record<ComfortWaypointStatus, string> = {
  PLANNED: 'Prévu',
  CONFIRMED: 'Confirmé',
  COMPLETED: 'Effectué',
  CANCELLED: 'Annulé',
  SKIPPED: 'Non effectué',
};

const ACTION_LABELS: Record<ComfortEventType, string> = {
  CONFIRMED: 'Confirmer',
  COMPLETED: 'Marquer effectué',
  CANCELLED: 'Annuler',
  SKIPPED: 'Marquer non effectué',
};

const FACILITY_LABELS: Record<ComfortFacility, string> = {
  RESTROOM: 'Toilettes',
  SHOWER: 'Douches',
  FOOD: 'Restauration',
  SECURE_PARKING: 'Stationnement sécurisé',
  FUEL: 'Ravitaillement',
};

const FACILITIES = Object.keys(FACILITY_LABELS) as ComfortFacility[];

const formatAt = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : '—';

function availableActions(
  step: AdminComfortStep,
  tripStatus: TrackingTripDetail['status'],
): ComfortEventType[] {
  if (step.status === 'COMPLETED' || step.status === 'CANCELLED' || step.status === 'SKIPPED') {
    return [];
  }

  if (step.status === 'PLANNED') {
    return ['CONFIRMED', 'CANCELLED', 'SKIPPED'];
  }

  const actions: ComfortEventType[] = ['CANCELLED', 'SKIPPED'];
  if (tripStatus === 'IN_PROGRESS' || tripStatus === 'COMPLETED') {
    actions.unshift('COMPLETED');
  }
  return actions;
}

export function ComfortAdmin({
  tripId,
  tripStatus,
}: {
  tripId: string;
  tripStatus: TrackingTripDetail['status'];
}) {
  const canManage = useCan('tracking.manage');
  const [view, setView] = useState<AdminComfortProjection | null>(null);
  const [busyWaypoint, setBusyWaypoint] = useState<string | null>(null);
  const [facilities, setFacilities] = useState<Record<string, ComfortFacility[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setError(null);
    const result = await auth.admin.tracking.comfort(tripId);
    if (seq !== requestSeq.current) return;
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setView(result.data);
  }, [tripId]);

  useEffect(() => {
    setView(null);
    setFacilities({});
    setNotice(null);
    void load();
    return () => {
      requestSeq.current += 1;
    };
  }, [load]);

  const toggleFacility = (routeWaypointId: string, facility: ComfortFacility) => {
    setFacilities((current) => {
      const selected = current[routeWaypointId] ?? [];
      return {
        ...current,
        [routeWaypointId]: selected.includes(facility)
          ? selected.filter((item) => item !== facility)
          : [...selected, facility],
      };
    });
  };

  const record = async (step: AdminComfortStep, type: ComfortEventType) => {
    setBusyWaypoint(step.routeWaypointId);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.admin.tracking.recordComfort(tripId, {
        clientEventId: `comfort-${crypto.randomUUID()}`,
        routeWaypointId: step.routeWaypointId,
        type,
        occurredAt: new Date().toISOString(),
        actualFacilities: type === 'COMPLETED' ? (facilities[step.routeWaypointId] ?? []) : [],
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(
        result.data.created
          ? `Étape ${step.code} mise à jour : ${STATUS_LABELS[type]}.`
          : 'Événement déjà enregistré.',
      );
      await load();
    } finally {
      setBusyWaypoint(null);
    }
  };

  return (
    <section
      className="et-network-panel"
      aria-labelledby="comfort-ops-title"
      data-testid="comfort-ops-panel"
    >
      <div className="et-actions">
        <div>
          <h3 id="comfort-ops-title">Confort voyageur et pauses</h3>
          <p className="et-hint">
            Les services planifiés viennent de TERANGA-STOPS. Les services réellement fournis ne
            sont enregistrés qu’au moment où une étape est marquée effectuée.
          </p>
        </div>
        <button
          type="button"
          className="et-button et-button--secondary"
          onClick={() => void load()}
        >
          Actualiser
        </button>
      </div>

      <FormAlert message={error} />
      {notice ? <FormStatus>{notice}</FormStatus> : null}
      {!view ? (
        <p role="status">Chargement des étapes confort…</p>
      ) : (
        <>
          <dl className="et-booking-admin-summary">
            <dt>Étape actuelle</dt>
            <dd>
              {view.currentStep ? `${view.currentStep.code} — ${view.currentStep.name}` : '—'}
            </dd>
            <dt>Prochaine étape</dt>
            <dd>{view.nextStep ? `${view.nextStep.code} — ${view.nextStep.name}` : '—'}</dd>
            <dt>Prochaine pause</dt>
            <dd>{view.nextPause ? `${view.nextPause.code} — ${view.nextPause.name}` : '—'}</dd>
            <dt>Dernière mise à jour</dt>
            <dd>{formatAt(view.lastUpdatedAt)}</dd>
          </dl>

          <div className="et-table-wrap">
            <table data-testid="comfort-ops-table">
              <caption>Étapes, pauses et services du voyage</caption>
              <thead>
                <tr>
                  <th>Étape</th>
                  <th>Visibilité</th>
                  <th>État</th>
                  <th>Horaire prévu</th>
                  <th>Services</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {view.steps.map((step) => {
                  const actions = availableActions(step, tripStatus);
                  const selected = facilities[step.routeWaypointId] ?? [];
                  return (
                    <tr key={step.routeWaypointId}>
                      <th scope="row">
                        {step.sequence}. {step.code} — {step.name}
                      </th>
                      <td>{step.travellerVisible ? 'Voyageur' : 'Interne'}</td>
                      <td>
                        <span className="et-tag">{STATUS_LABELS[step.status]}</span>
                      </td>
                      <td>{formatAt(step.plannedArrivalAt)}</td>
                      <td>
                        {step.status === 'COMPLETED' && step.actualFacilities.length > 0 ? (
                          <>
                            Constatés :{' '}
                            {step.actualFacilities.map((item) => FACILITY_LABELS[item]).join(', ')}
                          </>
                        ) : step.plannedFacilities.length > 0 ? (
                          <>
                            Prévus :{' '}
                            {step.plannedFacilities.map((item) => FACILITY_LABELS[item]).join(', ')}
                          </>
                        ) : (
                          '—'
                        )}
                        {canManage &&
                        step.status === 'CONFIRMED' &&
                        (tripStatus === 'IN_PROGRESS' || tripStatus === 'COMPLETED') ? (
                          <fieldset className="et-fieldset">
                            <legend>Services réellement fournis</legend>
                            {FACILITIES.map((facility) => (
                              <label key={facility}>
                                <input
                                  type="checkbox"
                                  checked={selected.includes(facility)}
                                  onChange={() => toggleFacility(step.routeWaypointId, facility)}
                                />{' '}
                                {FACILITY_LABELS[facility]}
                              </label>
                            ))}
                          </fieldset>
                        ) : null}
                      </td>
                      <td>
                        {canManage && actions.length > 0 ? (
                          <div className="et-actions">
                            {actions.map((type) => (
                              <button
                                key={type}
                                type="button"
                                className="et-button et-button--secondary"
                                disabled={busyWaypoint === step.routeWaypointId}
                                onClick={() => void record(step, type)}
                              >
                                {ACTION_LABELS[type]}
                              </button>
                            ))}
                          </div>
                        ) : actions.length > 0 ? (
                          'Lecture seule'
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {view.events.length > 0 ? (
            <details>
              <summary>Historique confort ({view.events.length})</summary>
              <ol>
                {view.events.map((event) => (
                  <li key={event.id}>
                    {formatAt(event.occurredAt)} — {event.waypoint.code ?? 'Étape'} —{' '}
                    {STATUS_LABELS[event.type]}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}
