'use client';

import type {
  ComfortFacility,
  ComfortStep,
  PublicTrackingProjection,
  TrackingProviderStatus,
} from '@euroteranga/auth-client';
import { JourneyShell } from '@euroteranga/ui';
import { useEffect, useState } from 'react';
import { auth } from '../lib/auth';
import { publicEnv } from '../lib/env';

const PROVIDER_LABELS: Record<TrackingProviderStatus, string> = {
  UP: 'Données récentes',
  DEGRADED: 'Service dégradé',
  STALE: 'Dernière donnée ancienne',
  UNAVAILABLE: 'GPS indisponible',
};

const COMFORT_STATUS_LABELS: Record<ComfortStep['status'], string> = {
  PLANNED: 'Prévu',
  CONFIRMED: 'Confirmé',
  COMPLETED: 'Effectué',
  CANCELLED: 'Annulé',
  SKIPPED: 'Non effectué',
};

const COMFORT_FACILITY_LABELS: Record<ComfortFacility, string> = {
  RESTROOM: 'Toilettes',
  SHOWER: 'Douches',
  FOOD: 'Restauration',
  SECURE_PARKING: 'Stationnement sécurisé',
  FUEL: 'Ravitaillement',
};

const formatAt = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : '—';

function ComfortStepCard({ title, step }: { title: string; step: ComfortStep | null }) {
  if (!step) {
    return (
      <div className="tracking-event">
        <span className="tracking-kicker">{title}</span>
        <span>Aucune étape annoncée.</span>
      </div>
    );
  }

  const facilities =
    step.status === 'COMPLETED' && step.actualFacilities.length > 0
      ? step.actualFacilities
      : step.plannedFacilities;
  const facilityPrefix =
    step.status === 'COMPLETED' && step.actualFacilities.length > 0
      ? 'Services constatés'
      : 'Services prévus';

  return (
    <div className="tracking-event">
      <span className="tracking-kicker">{title}</span>
      <strong>
        {step.name} — {step.locality}
      </strong>
      <span>
        {COMFORT_STATUS_LABELS[step.status]} · arrivée indicative {formatAt(step.plannedArrivalAt)}
      </span>
      {step.suggestedDwellMinutes ? (
        <span>Pause indicative : {step.suggestedDwellMinutes} min</span>
      ) : null}
      {facilities.length > 0 ? (
        <span>
          {facilityPrefix} :{' '}
          {facilities.map((facility) => COMFORT_FACILITY_LABELS[facility]).join(', ')}
        </span>
      ) : null}
    </div>
  );
}

export function PublicTracking({ token }: { token: string }) {
  const [data, setData] = useState<PublicTrackingProjection | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    let active = true;
    void auth.tracking.public(token).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setData(null);
        setState('unavailable');
        return;
      }
      setData(result.data);
      setState('ready');
    });
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <JourneyShell
      area="Suivi de voyage"
      title="Où en est votre voyage ?"
      subtitle="Consultez les informations opérationnelles publiées pour votre trajet."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      current="tracking"
    >
      {state === 'loading' ? <p role="status">Chargement du suivi…</p> : null}

      {state === 'unavailable' ? (
        <section className="tracking-card" role="status" data-testid="tracking-unavailable">
          <h2>Suivi indisponible</h2>
          <p>
            Ce lien est invalide, expiré, révoqué ou le suivi public de ce voyage est désactivé.
          </p>
        </section>
      ) : null}

      {data ? (
        <div className="tracking-stack" data-testid="public-tracking">
          <section className="tracking-card">
            <div className="tracking-heading">
              <div>
                <span className="tracking-kicker">Voyage</span>
                <h2>{data.tripReference}</h2>
              </div>
              <span className="tracking-badge">{data.tripStatus}</span>
            </div>
            <dl className="tracking-grid">
              <dt>Route</dt>
              <dd>
                {data.route.code} — {data.route.name}
              </dd>
              <dt>Départ prévu</dt>
              <dd>{formatAt(data.plannedDepartureAt)}</dd>
              <dt>Arrivée prévue</dt>
              <dd>{formatAt(data.plannedArrivalAt)}</dd>
              <dt>Dernière mise à jour</dt>
              <dd>{formatAt(data.lastUpdatedAt)}</dd>
            </dl>
          </section>

          <section className="tracking-card" aria-labelledby="tracking-progress-title">
            <div className="tracking-heading">
              <div>
                <span className="tracking-kicker">Progression</span>
                <h2 id="tracking-progress-title">Dernière information</h2>
              </div>
              <span className="tracking-badge" data-testid="public-tracking-provider-status">
                {PROVIDER_LABELS[data.providerStatus]}
              </span>
            </div>

            {data.checkpoint ? (
              <div className="tracking-event" data-testid="public-tracking-checkpoint">
                <strong>
                  {data.checkpoint.code} — {data.checkpoint.name}
                </strong>
                <span>{formatAt(data.checkpoint.observedAt)}</span>
              </div>
            ) : (
              <p>Aucun checkpoint publié pour le moment.</p>
            )}

            {data.position ? (
              <div className="tracking-position" data-testid="public-tracking-position">
                <span className="tracking-kicker">
                  {data.position.precision === 'PRECISE'
                    ? 'Position précise'
                    : 'Zone approximative'}
                </span>
                <strong>
                  {data.position.latitude.toFixed(data.position.precision === 'PRECISE' ? 6 : 1)},{' '}
                  {data.position.longitude.toFixed(data.position.precision === 'PRECISE' ? 6 : 1)}
                </strong>
                <span>{formatAt(data.position.observedAt)}</span>
                {data.position.precision === 'PRECISE' &&
                data.position.accuracyMeters !== undefined &&
                data.position.accuracyMeters !== null ? (
                  <span>Précision annoncée : {data.position.accuracyMeters} m</span>
                ) : null}
              </div>
            ) : (
              <p data-testid="public-tracking-no-position">
                Aucune position géographique n’est publiée pour ce niveau de suivi.
              </p>
            )}
          </section>

          <section
            className="tracking-card"
            aria-labelledby="tracking-comfort-title"
            data-testid="public-comfort"
          >
            <div className="tracking-heading">
              <div>
                <span className="tracking-kicker">Confort du voyage</span>
                <h2 id="tracking-comfort-title">Prochaine étape et prochaine pause</h2>
              </div>
              <span className="tracking-badge">Information voyageur</span>
            </div>
            <div className="tracking-comfort-grid">
              <ComfortStepCard title="Dernière étape connue" step={data.comfort.currentStep} />
              <ComfortStepCard title="Prochaine étape" step={data.comfort.nextStep} />
              <ComfortStepCard title="Prochaine pause" step={data.comfort.nextPause} />
            </div>
            <p className="tracking-privacy">
              Les horaires, pauses et services prévus restent indicatifs jusqu’à leur confirmation
              opérationnelle.
            </p>
          </section>

          <p className="tracking-privacy">
            Le suivi public affiche uniquement les informations autorisées pour ce voyage.
          </p>
        </div>
      ) : null}
    </JourneyShell>
  );
}
