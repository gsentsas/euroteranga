'use client';

import type {
  PublicRoadFreightTracking,
  PublicRoadFreightTrackingStatus,
} from '@euroteranga/auth-client';
import { JourneyShell } from '@euroteranga/ui';
import { useEffect, useState } from 'react';
import { auth } from '../lib/auth';
import { publicEnv } from '../lib/env';

const STATUS_LABELS: Record<PublicRoadFreightTrackingStatus, string> = {
  PREPARING: 'Préparation',
  RECEIVED: 'Pris en charge',
  IN_TRANSIT: 'En transit',
  ARRIVED: 'Arrivé',
  AVAILABLE: 'Disponible',
  DELIVERED: 'Livré',
  ATTENTION: 'Traitement en cours',
  CANCELLED: 'Clôturé',
};

const DIRECTION_LABELS = {
  PAR_DKR: 'Paris → Dakar',
  DKR_PAR: 'Dakar → Paris',
} as const;

const formatAt = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : '—';

export function PublicCargoTracking({ token }: { token: string }) {
  const [data, setData] = useState<PublicRoadFreightTracking | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    let active = true;
    void auth.cargoTracking.public(token).then((result) => {
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
      area="Suivi fret"
      title="Suivez votre envoi EURO TERANGA."
      subtitle="Le lien public affiche uniquement la progression autorisée de votre colis ou fret."
      environment={publicEnv.NEXT_PUBLIC_APP_ENV}
      current="tracking"
    >
      {state === 'loading' ? <p role="status">Chargement du suivi fret…</p> : null}

      {state === 'unavailable' ? (
        <section className="tracking-card" role="status" data-testid="cargo-tracking-unavailable">
          <h2>Suivi indisponible</h2>
          <p>Ce lien est invalide, expiré ou révoqué.</p>
        </section>
      ) : null}

      {data ? (
        <div className="tracking-stack" data-testid="public-cargo-tracking">
          <section className="tracking-card">
            <div className="tracking-heading">
              <div>
                <span className="tracking-kicker">Colis / fret</span>
                <h2>{data.reference}</h2>
              </div>
              <span className="tracking-badge">{STATUS_LABELS[data.status]}</span>
            </div>
            <dl className="tracking-grid">
              <dt>Trajet</dt>
              <dd>{DIRECTION_LABELS[data.direction]}</dd>
              <dt>Nombre de pièces</dt>
              <dd>{data.packageCount}</dd>
              <dt>Dernière mise à jour</dt>
              <dd>{formatAt(data.lastUpdatedAt)}</dd>
              {data.trip ? (
                <>
                  <dt>Route</dt>
                  <dd>
                    {data.trip.route.code} — {data.trip.route.name}
                  </dd>
                  <dt>Départ prévu</dt>
                  <dd>{formatAt(data.trip.plannedDepartureAt)}</dd>
                  <dt>Arrivée prévue</dt>
                  <dd>{formatAt(data.trip.plannedArrivalAt)}</dd>
                </>
              ) : null}
            </dl>
          </section>

          <section className="tracking-card" aria-labelledby="cargo-tracking-progress-title">
            <div className="tracking-heading">
              <div>
                <span className="tracking-kicker">Progression</span>
                <h2 id="cargo-tracking-progress-title">Dernière étape connue</h2>
              </div>
            </div>
            {data.location ? (
              <div className="tracking-event" data-testid="public-cargo-tracking-location">
                <strong>
                  {data.location.code} — {data.location.name}
                </strong>
                <span>{formatAt(data.location.observedAt)}</span>
              </div>
            ) : (
              <p data-testid="public-cargo-tracking-no-location">
                Aucune étape publique enregistrée pour le moment.
              </p>
            )}
          </section>

          <p className="tracking-privacy">
            Ce suivi ne publie ni coordonnées personnelles, ni contenu déclaré, ni valeur, ni prix,
            ni position GPS précise.
          </p>
        </div>
      ) : null}
    </JourneyShell>
  );
}
