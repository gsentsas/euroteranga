'use client';

import type {
  BorderEventType,
  BorderState,
  BorderTripView,
  TrackingDevice,
  TrackingProviderStatus,
  TrackingTripDetail,
  TrackingTripSummary,
  TrackingVisibility,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { auth } from '../../lib/auth';
import { OpsKpiCard, OpsStatusBadge } from '../ops-ui';
import { useCan } from '../staff-access';
import { useTripReferenceParam } from '../trips/trip-link';
import { ComfortAdmin } from './comfort-admin';

const VISIBILITY_LABELS: Record<TrackingVisibility, string> = {
  HIDDEN: 'Masqué',
  CHECKPOINT_ONLY: 'Checkpoints uniquement',
  APPROXIMATE: 'Position approximative',
  PRECISE: 'Position précise',
};

const PROVIDER_LABELS: Record<TrackingProviderStatus, string> = {
  UP: 'Actif',
  DEGRADED: 'Dégradé',
  STALE: 'Données anciennes',
  UNAVAILABLE: 'Indisponible',
};

function providerTone(
  status: TrackingProviderStatus,
): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  switch (status) {
    case 'UP':
      return 'success';
    case 'DEGRADED':
      return 'warning';
    case 'STALE':
      return 'warning';
    case 'UNAVAILABLE':
      return 'danger';
  }
}

function visibilityTone(
  visibility: TrackingVisibility,
): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  switch (visibility) {
    case 'PRECISE':
      return 'success';
    case 'APPROXIMATE':
      return 'info';
    case 'CHECKPOINT_ONLY':
      return 'warning';
    case 'HIDDEN':
      return 'neutral';
  }
}

const formatAt = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : '—';

const BORDER_STATE_LABELS: Record<BorderState, string> = {
  PENDING: 'À venir',
  ARRIVED: 'Arrivé',
  CONTROL_STARTED: 'Contrôle en cours',
  CONTROL_COMPLETED: 'Contrôle terminé',
  DEPARTED: 'Franchie',
};

function nextBorderEvent(state: BorderState): BorderEventType | null {
  switch (state) {
    case 'PENDING':
      return 'ARRIVED';
    case 'ARRIVED':
      return 'CONTROL_STARTED';
    case 'CONTROL_STARTED':
      return 'CONTROL_COMPLETED';
    case 'CONTROL_COMPLETED':
      return 'DEPARTED';
    case 'DEPARTED':
      return null;
  }
}

const BORDER_ACTION_LABELS: Record<BorderEventType, string> = {
  ARRIVED: 'Signaler l’arrivée',
  CONTROL_STARTED: 'Démarrer le contrôle',
  CONTROL_COMPLETED: 'Terminer le contrôle',
  DEPARTED: 'Signaler le départ',
};

function BorderPanel({
  tripId,
  tripStatus,
}: {
  tripId: string;
  tripStatus: TrackingTripDetail['status'];
}) {
  const canRead = useCan('border.read');
  const canManage = useCan('border.manage');
  const [view, setView] = useState<BorderTripView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canRead) return;
    const result = await auth.admin.borders.trip(tripId);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setView(result.data);
  }, [canRead, tripId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canRead) return null;

  const record = async (routeWaypointId: string, type: BorderEventType) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await auth.admin.borders.record(tripId, {
        clientEventId: `evt-${crypto.randomUUID()}`,
        routeWaypointId,
        type,
        occurredAt: new Date().toISOString(),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(
        result.data.created ? 'Événement frontière enregistré.' : 'Événement déjà enregistré.',
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="et-network-panel"
      aria-labelledby="border-ops-title"
      data-testid="border-ops-panel"
    >
      <h3 id="border-ops-title">Passages frontière</h3>
      <p className="et-hint">
        Journal opérationnel de passage uniquement. Il ne vaut ni décision douanière, ni visa, ni
        autorisation d’entrée sur le territoire.
      </p>
      <FormAlert message={error} />
      {notice ? <FormStatus>{notice}</FormStatus> : null}
      {!view ? (
        <p role="status">Chargement des frontières…</p>
      ) : view.borders.length === 0 ? (
        <p>Aucun point frontière sur cette route.</p>
      ) : (
        <div className="et-table-wrap">
          <table data-testid="border-ops-table">
            <caption>État opérationnel des passages frontière</caption>
            <thead>
              <tr>
                <th>Étape</th>
                <th>État</th>
                <th>Dernier événement</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {view.borders.map((border) => {
                const next = nextBorderEvent(border.currentState);
                return (
                  <tr key={border.routeWaypointId}>
                    <th scope="row">
                      {border.sequence}. {border.code ?? '—'} — {border.name ?? 'Frontière'}
                    </th>
                    <td>{BORDER_STATE_LABELS[border.currentState]}</td>
                    <td>{formatAt(border.latestOccurredAt)}</td>
                    <td>
                      {next && canManage ? (
                        <button
                          type="button"
                          className="et-button et-button--secondary"
                          disabled={busy || tripStatus !== 'IN_PROGRESS'}
                          onClick={() => void record(border.routeWaypointId, next)}
                        >
                          {BORDER_ACTION_LABELS[next]}
                        </button>
                      ) : next ? (
                        'Lecture seule'
                      ) : (
                        'Terminé'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {view?.events.length ? (
        <details>
          <summary>Historique ({view.events.length})</summary>
          <ol>
            {view.events.map((event) => (
              <li key={event.id}>
                {formatAt(event.occurredAt)} — {event.waypoint.code ?? 'Frontière'} —{' '}
                {BORDER_STATE_LABELS[event.type]} — {event.source}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

function ConfigPanel({
  detail,
  devices,
  disabled,
  onChanged,
}: {
  detail: TrackingTripDetail;
  devices: readonly TrackingDevice[];
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const canManage = useCan('tracking.manage');
  const [enabled, setEnabled] = useState(detail.config?.enabled ?? false);
  const [visibility, setVisibility] = useState<TrackingVisibility>(
    detail.config?.visibility ?? 'HIDDEN',
  );
  const [deviceId, setDeviceId] = useState(detail.config?.trackingDevice?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(detail.config?.enabled ?? false);
    setVisibility(detail.config?.visibility ?? 'HIDDEN');
    setDeviceId(detail.config?.trackingDevice?.id ?? '');
  }, [detail]);

  if (!canManage) return null;

  const compatible = devices.filter(
    (device) => device.active && (!detail.vehicle || device.vehicle.id === detail.vehicle.id),
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    setError(null);
    setNotice(null);
    const result = await auth.admin.tracking.configure(detail.id, {
      enabled,
      visibility,
      trackingDeviceId: deviceId || null,
    });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setNotice('Configuration Tracking enregistrée.');
    await onChanged();
  };

  return (
    <section className="et-network-panel" aria-labelledby="tracking-config-title">
      <h3 id="tracking-config-title">Configuration du suivi</h3>
      <p className="et-hint">
        Recevoir une position GPS ne la rend jamais publique. La précision publique reste une
        décision explicite.
      </p>
      <FormAlert message={error} />
      {notice ? <FormStatus>{notice}</FormStatus> : null}
      <form className="et-form et-network-form" onSubmit={(event) => void submit(event)}>
        <label className="et-field">
          <span>Suivi actif</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
        </label>
        <label className="et-field">
          Visibilité publique
          <select
            className="et-select"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as TrackingVisibility)}
          >
            {Object.entries(VISIBILITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="et-field">
          Device GPS
          <select
            className="et-select"
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            <option value="">Aucun</option>
            {compatible.map((device) => (
              <option key={device.id} value={device.id}>
                {device.providerKey} · {device.externalId} · {device.vehicle.code}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="et-button" disabled={disabled}>
          Enregistrer
        </button>
      </form>
    </section>
  );
}

function DevicePanel({
  detail,
  disabled,
  onCreated,
}: {
  detail: TrackingTripDetail;
  disabled: boolean;
  onCreated: () => Promise<void>;
}) {
  const canManage = useCan('tracking.manage');
  const [providerKey, setProviderKey] = useState('');
  const [externalId, setExternalId] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const vehicle = detail.vehicle;
  if (!canManage || !vehicle) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || !providerKey.trim() || !externalId.trim()) return;
    setMessage(null);
    const result = await auth.admin.tracking.createDevice({
      vehicleId: vehicle.id,
      providerKey: providerKey.trim().toUpperCase(),
      externalId: externalId.trim(),
    });
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setProviderKey('');
    setExternalId('');
    setMessage('Device de suivi enregistré.');
    await onCreated();
  };

  return (
    <section className="et-network-panel" aria-labelledby="tracking-device-title">
      <h3 id="tracking-device-title">Associer un device GPS au véhicule</h3>
      <form className="et-form et-network-form" onSubmit={(event) => void submit(event)}>
        <label className="et-field">
          Provider
          <input
            className="et-input"
            value={providerKey}
            maxLength={64}
            placeholder="TRACCAR"
            onChange={(event) => setProviderKey(event.target.value)}
          />
        </label>
        <label className="et-field">
          Identifiant externe
          <input
            className="et-input"
            value={externalId}
            maxLength={128}
            onChange={(event) => setExternalId(event.target.value)}
          />
        </label>
        <button className="et-button et-button--secondary" type="submit" disabled={disabled}>
          Ajouter le device
        </button>
      </form>
      {message ? <FormStatus>{message}</FormStatus> : null}
    </section>
  );
}

function TokenPanel({
  detail,
  disabled,
  onChanged,
}: {
  detail: TrackingTripDetail;
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const canManage = useCan('tracking.manage');
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!canManage) return null;

  const issue = async () => {
    if (disabled) return;
    setMessage(null);
    const result = await auth.admin.tracking.issueToken(detail.id);
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setRawToken(result.data.token);
    setMessage(
      'Lien créé. Le token brut est affiché une seule fois et n’est pas stocké sur le serveur.',
    );
    await onChanged();
  };

  const revoke = async (tokenId: string) => {
    const reason = window.prompt('Motif de révocation du lien public :');
    if (!reason?.trim()) return;
    const result = await auth.admin.tracking.revokeToken(detail.id, tokenId, reason.trim());
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setRawToken(null);
    setMessage('Lien public révoqué.');
    await onChanged();
  };

  return (
    <section className="et-network-panel" aria-labelledby="tracking-token-title">
      <div className="et-actions">
        <h3 id="tracking-token-title">Liens publics</h3>
        <button
          type="button"
          className="et-button"
          disabled={disabled}
          onClick={() => void issue()}
        >
          Créer un lien
        </button>
      </div>
      {message ? <FormStatus>{message}</FormStatus> : null}
      {rawToken ? (
        <div className="et-alert" role="status" data-testid="tracking-issued-token">
          <strong>Token à transmettre :</strong>
          <div className="et-code">{rawToken}</div>
        </div>
      ) : null}
      <div className="et-table-wrap">
        <table>
          <caption>Capabilities publiques du voyage</caption>
          <thead>
            <tr>
              <th>Créé</th>
              <th>Expiration</th>
              <th>État</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {detail.publicTokens.map((token) => (
              <tr key={token.id}>
                <td>{formatAt(token.createdAt)}</td>
                <td>{formatAt(token.expiresAt)}</td>
                <td>{token.revokedAt ? 'Révoqué' : 'Actif'}</td>
                <td>
                  {token.revokedAt ? (
                    '—'
                  ) : (
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      disabled={disabled}
                      onClick={() => void revoke(token.id)}
                    >
                      Révoquer
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrackingDetail({
  detail,
  devices,
  busy,
  reload,
}: {
  detail: TrackingTripDetail;
  devices: readonly TrackingDevice[];
  busy: boolean;
  reload: () => Promise<void>;
}) {
  return (
    <section className="et-network-panel" aria-labelledby="tracking-detail-title">
      <h2 id="tracking-detail-title">Tracking {detail.reference}</h2>
      <dl className="et-booking-admin-summary" data-testid="tracking-detail">
        <dt>Route</dt>
        <dd>
          {detail.route.code} — {detail.route.name}
        </dd>
        <dt>Véhicule</dt>
        <dd>{detail.vehicle?.code ?? 'Aucun'}</dd>
        <dt>Tracking</dt>
        <dd>{detail.config?.enabled ? 'Actif' : 'Inactif'}</dd>
        <dt>Visibilité</dt>
        <dd>{VISIBILITY_LABELS[detail.config?.visibility ?? 'HIDDEN']}</dd>
        <dt>Provider</dt>
        <dd data-testid="tracking-provider-status">
          <OpsStatusBadge tone={providerTone(detail.providerStatus)}>
            {PROVIDER_LABELS[detail.providerStatus]}
          </OpsStatusBadge>
        </dd>
      </dl>

      <ConfigPanel detail={detail} devices={devices} disabled={busy} onChanged={reload} />
      <DevicePanel detail={detail} disabled={busy} onCreated={reload} />
      <TokenPanel detail={detail} disabled={busy} onChanged={reload} />
      <ComfortAdmin tripId={detail.id} tripStatus={detail.status} />
      <BorderPanel tripId={detail.id} tripStatus={detail.status} />

      <h3>Timeline des observations</h3>
      <div className="et-table-wrap">
        <table data-testid="tracking-observations">
          <caption>100 dernières observations internes</caption>
          <thead>
            <tr>
              <th>Date</th>
              <th>Source</th>
              <th>Checkpoint</th>
              <th>Position interne</th>
              <th>Provider</th>
            </tr>
          </thead>
          <tbody>
            {detail.observations.map((observation) => (
              <tr key={observation.id}>
                <td>{formatAt(observation.observedAt)}</td>
                <td>{observation.source}</td>
                <td>
                  {observation.checkpoint
                    ? observation.checkpoint.code + ' — ' + observation.checkpoint.name
                    : '—'}
                </td>
                <td>
                  {observation.latitude === null || observation.longitude === null
                    ? '—'
                    : observation.latitude.toFixed(6) + ', ' + observation.longitude.toFixed(6)}
                </td>
                <td>{observation.providerKey ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail.observations.length === 0 ? <p>Aucune observation.</p> : null}
    </section>
  );
}

export function TrackingAdmin() {
  const [trips, setTrips] = useState<TrackingTripSummary[] | null>(null);
  const [devices, setDevices] = useState<TrackingDevice[]>([]);
  const [selectedTripId, setSelectedTripId] = useState('');
  // `/tracking?voyage=REF` (trip cockpit) selects that trip once the list is known.
  const linkedTrip = useTripReferenceParam();
  const [detail, setDetail] = useState<TrackingTripDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const [tripResult, deviceResult] = await Promise.all([
      auth.admin.tracking.trips(),
      auth.admin.tracking.devices(),
    ]);
    if (!tripResult.ok) {
      setError(tripResult.error.message);
      return;
    }
    setTrips(tripResult.data.items);
    if (deviceResult.ok) setDevices(deviceResult.data.items);
  }, []);

  const loadDetail = useCallback(async (tripId: string) => {
    if (!tripId) {
      setDetail(null);
      return;
    }
    const result = await auth.admin.tracking.trip(tripId);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setDetail(result.data);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!linkedTrip || !trips) return;
    const linked = trips.find((trip) => trip.reference === linkedTrip);
    if (linked) setSelectedTripId((current) => current || linked.id);
  }, [linkedTrip, trips]);

  useEffect(() => {
    void loadDetail(selectedTripId);
  }, [loadDetail, selectedTripId]);

  const reload = async () => {
    setBusy(true);
    setError(null);
    try {
      await Promise.all([loadList(), loadDetail(selectedTripId)]);
    } finally {
      setBusy(false);
    }
  };

  if (!trips) return <p role="status">Chargement du Tracking…</p>;

  const enabledCount = trips.filter((trip) => trip.config?.enabled).length;
  const healthyCount = trips.filter((trip) => trip.providerStatus === 'UP').length;
  const attentionCount = trips.filter(
    (trip) =>
      trip.providerStatus === 'DEGRADED' ||
      trip.providerStatus === 'STALE' ||
      trip.providerStatus === 'UNAVAILABLE',
  ).length;

  return (
    <div
      className="et-network ops-operations-workspace ops-tracking-workspace"
      data-testid="tracking-workspace"
    >
      <div className="ops-operations-intro">
        <div>
          <p className="ops-operations-eyebrow">Supervision terrain</p>
          <h2>Tracking des voyages</h2>
          <p>
            Suivi opérationnel des positions, devices et capacités publiques. La réception d’une
            donnée GPS ne modifie jamais automatiquement sa visibilité publique.
          </p>
        </div>
      </div>

      <FormAlert message={error} />

      <section className="ops-operations-kpis" aria-label="Indicateurs du Tracking">
        <OpsKpiCard
          label="Voyages suivis"
          value={trips.length}
          helper="Planifiés ou en cours"
          icon="location"
          tone="info"
        />
        <OpsKpiCard
          label="Suivi actif"
          value={enabledCount}
          helper="Tracking explicitement activé"
          icon="route"
          tone="success"
        />
        <OpsKpiCard
          label="Providers actifs"
          value={healthyCount}
          helper="Source de données disponible"
          icon="check"
          tone="success"
        />
        <OpsKpiCard
          label="À surveiller"
          value={attentionCount}
          helper="Dégradé, ancien ou indisponible"
          icon="alert"
          tone={attentionCount > 0 ? 'warning' : 'neutral'}
        />
      </section>

      <section
        className="et-network-panel ops-operations-section ops-operations-section--primary"
        aria-labelledby="tracking-trips-title"
      >
        <div className="et-actions">
          <div>
            <p className="ops-operations-section-kicker">Exploitation temps réel</p>
            <h2 id="tracking-trips-title">Voyages actifs</h2>
          </div>
          <button
            className="et-button et-button--secondary"
            type="button"
            disabled={busy}
            onClick={() => void reload()}
          >
            Actualiser
          </button>
        </div>
        <div className="et-table-wrap">
          <table data-testid="tracking-trips">
            <caption>Tracking des voyages planifiés ou en cours</caption>
            <thead>
              <tr>
                <th>Voyage</th>
                <th>Route</th>
                <th>Véhicule</th>
                <th>Visibilité</th>
                <th>Provider</th>
                <th>Dernière donnée</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((trip) => (
                <tr key={trip.id}>
                  <th scope="row">{trip.reference}</th>
                  <td>{trip.route.code}</td>
                  <td>{trip.vehicle?.code ?? '—'}</td>
                  <td>
                    <OpsStatusBadge tone={visibilityTone(trip.config?.visibility ?? 'HIDDEN')}>
                      {VISIBILITY_LABELS[trip.config?.visibility ?? 'HIDDEN']}
                    </OpsStatusBadge>
                  </td>
                  <td>
                    <OpsStatusBadge tone={providerTone(trip.providerStatus)}>
                      {PROVIDER_LABELS[trip.providerStatus]}
                    </OpsStatusBadge>
                  </td>
                  <td>{formatAt(trip.lastObservation?.observedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      onClick={() => setSelectedTripId(trip.id)}
                    >
                      Détail
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {trips.length === 0 ? <p>Aucun voyage actif.</p> : null}
      </section>

      {detail ? (
        <TrackingDetail detail={detail} devices={devices} busy={busy} reload={reload} />
      ) : null}
    </div>
  );
}
