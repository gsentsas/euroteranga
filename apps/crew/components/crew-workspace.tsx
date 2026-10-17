'use client';

import type {
  ApiError,
  CrewOfflineEvent,
  CrewTripSnapshot,
  IncidentSeverity,
  IncidentType,
} from '@euroteranga/auth-client';
import { FormAlert, FormStatus } from '@euroteranga/ui';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { auth } from '../lib/auth';
import {
  applySyncResults,
  bindIdentity,
  cachedTripSnapshots,
  clearOfflineData,
  deviceId,
  discardEvent,
  localEvents,
  markFailed,
  markNetworkFailure,
  markSyncing,
  markTemporaryFailure,
  purgeExpiredData,
  queueBoarding,
  queueBorderEvent,
  queueIncidentReport,
  queueTrackingCheckpoint,
  recoverInterruptedSync,
  replaceTripSnapshots,
  retryEvent,
  returnPending,
  type LocalCrewEvent,
} from '../lib/offline-store';
import { retryDelayMs } from '../lib/offline-model';

type RefreshResult = 'READY' | 'TRANSIENT_FAILURE' | 'STOPPED';

function isTransientApiError(error: ApiError): boolean {
  return (
    error.code === 'NETWORK_ERROR' ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500
  );
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function syncEvent(item: LocalCrewEvent): CrewOfflineEvent {
  if (item.type === 'PASSENGER_BOARDING') {
    return {
      clientEventId: item.clientEventId,
      type: item.type,
      occurredAt: item.occurredAt,
      payload: { qrPayload: item.payload.qrPayload },
    };
  }
  if (item.type === 'BORDER_EVENT') {
    return {
      clientEventId: item.clientEventId,
      type: item.type,
      occurredAt: item.occurredAt,
      payload: {
        routeWaypointId: item.payload.routeWaypointId,
        eventType: item.payload.eventType,
      },
    };
  }
  if (item.type === 'INCIDENT_REPORTED') {
    return {
      clientEventId: item.clientEventId,
      type: item.type,
      occurredAt: item.occurredAt,
      payload: {
        incidentType: item.payload.incidentType,
        severity: item.payload.severity,
        description: item.payload.description,
        ...(item.payload.routeWaypointId ? { routeWaypointId: item.payload.routeWaypointId } : {}),
        ...(item.payload.locationLabel ? { locationLabel: item.payload.locationLabel } : {}),
        ...(item.payload.baggageReference
          ? { baggageReference: item.payload.baggageReference }
          : {}),
      },
    };
  }
  return {
    clientEventId: item.clientEventId,
    type: item.type,
    occurredAt: item.occurredAt,
    payload: { routeWaypointId: item.payload.routeWaypointId },
  };
}

type BorderState = 'PENDING' | 'ARRIVED' | 'CONTROL_STARTED' | 'CONTROL_COMPLETED' | 'DEPARTED';
type BorderEventType = Exclude<BorderState, 'PENDING'>;

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

function borderEventLabel(type: BorderEventType): string {
  switch (type) {
    case 'ARRIVED':
      return 'Signaler l’arrivée';
    case 'CONTROL_STARTED':
      return 'Démarrer le contrôle';
    case 'CONTROL_COMPLETED':
      return 'Terminer le contrôle';
    case 'DEPARTED':
      return 'Signaler le départ';
  }
}

function borderStateLabel(state: BorderState): string {
  switch (state) {
    case 'PENDING':
      return 'À venir';
    case 'ARRIVED':
      return 'Arrivé';
    case 'CONTROL_STARTED':
      return 'Contrôle en cours';
    case 'CONTROL_COMPLETED':
      return 'Contrôle terminé';
    case 'DEPARTED':
      return 'Franchie';
  }
}

const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  BREAKDOWN: 'Panne',
  ACCIDENT: 'Accident',
  DELAY: 'Retard',
  BORDER: 'Frontière',
  CUSTOMS: 'Douane',
  POLICE: 'Police',
  PASSENGER: 'Passager',
  HEALTH: 'Santé',
  BAGGAGE: 'Bagage',
  SECURITY: 'Sécurité',
  WEATHER: 'Météo',
  FERRY: 'Ferry',
  OTHER: 'Autre',
};

const INCIDENT_SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  LOW: 'Faible',
  MEDIUM: 'Moyenne',
  HIGH: 'Élevée',
  CRITICAL: 'Critique',
};

const INCIDENT_TYPES = Object.keys(INCIDENT_TYPE_LABELS) as IncidentType[];
const INCIDENT_SEVERITIES = Object.keys(INCIDENT_SEVERITY_LABELS) as IncidentSeverity[];

function eventLabel(status: LocalCrewEvent['status']) {
  switch (status) {
    case 'PENDING':
      return 'En attente';
    case 'SYNCING':
      return 'Synchronisation';
    case 'ACKNOWLEDGED':
      return 'Synchronisé avec EURO TERANGA';
    case 'REJECTED':
      return 'Refusé par le serveur';
    case 'CONFLICT':
      return 'Conflit';
  }
}

export function CrewWorkspace() {
  const router = useRouter();
  const [online, setOnline] = useState(false);
  const [trips, setTrips] = useState<CrewTripSnapshot[]>([]);
  const [events, setEvents] = useState<LocalCrewEvent[]>([]);
  const [selectedTrip, setSelectedTrip] = useState('');
  const [qrPayload, setQrPayload] = useState('');
  const [checkpointWaypointId, setCheckpointWaypointId] = useState('');
  const [incidentType, setIncidentType] = useState<IncidentType>('DELAY');
  const [incidentSeverity, setIncidentSeverity] = useState<IncidentSeverity>('MEDIUM');
  const [incidentDescription, setIncidentDescription] = useState('');
  const [incidentLocation, setIncidentLocation] = useState('');
  const [incidentBaggageReference, setIncidentBaggageReference] = useState('');
  const [device, setDevice] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const syncLock = useRef(false);

  const refreshLocal = useCallback(async () => {
    const [cached, queued] = await Promise.all([cachedTripSnapshots(), localEvents()]);
    setTrips(cached);
    setEvents(queued);
    setSelectedTrip((current) =>
      cached.some((item) => item.trip.reference === current)
        ? current
        : (cached[0]?.trip.reference ?? ''),
    );
  }, []);

  const syncQueued = useCallback(
    async (knownDevice?: string, force = false) => {
      if (!navigator.onLine || syncLock.current) return;
      const id = knownDevice ?? (await deviceId());
      const now = Date.now();
      const queued = (await localEvents()).filter(
        (item) => item.status === 'PENDING' && (force || Date.parse(item.nextAttemptAt) <= now),
      );
      if (queued.length === 0) {
        await refreshLocal();
        return;
      }

      syncLock.current = true;
      setSyncing(true);
      setError(null);
      let acknowledged = 0;
      try {
        const byTrip = new Map<string, LocalCrewEvent[]>();
        for (const item of queued) {
          const group = byTrip.get(item.tripReference) ?? [];
          group.push(item);
          byTrip.set(item.tripReference, group);
        }

        for (const [tripReference, group] of byTrip) {
          for (let start = 0; start < group.length; start += 25) {
            const batch = group.slice(start, start + 25);
            const ids = batch.map((item) => item.clientEventId);
            await markSyncing(ids);
            const result = await auth.crew.sync(tripReference, id, batch.map(syncEvent));
            if (!result.ok) {
              if (result.error.code === 'NETWORK_ERROR') {
                await markNetworkFailure(ids);
                setNotice(
                  'Réseau indisponible : les événements restent enregistrés sur cet appareil.',
                );
                return;
              }
              if (result.error.status === 401) {
                await returnPending(ids);
                setNotice(
                  'Session expirée : les actions locales sont conservées pour la reconnexion.',
                );
                router.replace('/connexion');
                return;
              }
              if (result.error.code === 'CREW_TRIP_NOT_ASSIGNED') {
                await markFailed(ids, result.error.code);
                setError(
                  'Affectation retirée : seuls les événements de ce voyage sont à vérifier.',
                );
                continue;
              }
              if (
                result.error.status === 403 ||
                result.error.status === 429 ||
                result.error.status >= 500 ||
                result.error.code === 'CREW_DEVICE_UNAVAILABLE'
              ) {
                await markTemporaryFailure(ids, result.error.code, 30_000);
                setError(`${result.error.message} Les actions locales sont conservées.`);
                return;
              }
              await markFailed(ids, result.error.code);
              setError(result.error.message);
              continue;
            }
            await applySyncResults(result.data.results);
            acknowledged += result.data.results.filter(
              (item) => item.status === 'ACKNOWLEDGED',
            ).length;
          }
        }
        if (acknowledged > 0) setNotice('Action(s) synchronisée(s) avec EURO TERANGA.');
      } finally {
        syncLock.current = false;
        setSyncing(false);
        await refreshLocal();
      }
    },
    [refreshLocal, router],
  );

  const refreshFromServer = useCallback(async (): Promise<RefreshResult> => {
    const me = await auth.me('crew');
    if (!me.ok) {
      if (me.error.status === 401) {
        setNotice('Session expirée : les actions locales sont conservées pour la reconnexion.');
        router.replace('/connexion');
        return 'STOPPED';
      }
      if (isTransientApiError(me.error)) {
        setNotice('Core API indisponible : nouvelle tentative automatique en cours.');
        return 'TRANSIENT_FAILURE';
      }
      setError(me.error.message);
      return 'STOPPED';
    }

    setEmail(me.data.email);
    const changedIdentity = await bindIdentity(me.data.id);
    const id = await deviceId();
    setDevice(id);
    if (changedIdentity) {
      setNotice('Identité vérifiée : stockage local initialisé pour cette session Crew.');
    }

    const enrolled = await auth.crew.enrollDevice(id, 'PWA Crew');
    if (!enrolled.ok) {
      if (enrolled.error.status === 401) {
        setNotice('Session expirée : les actions locales sont conservées pour la reconnexion.');
        router.replace('/connexion');
        return 'STOPPED';
      }
      if (isTransientApiError(enrolled.error)) {
        setNotice('Core API indisponible : appareil conservé, nouvelle tentative automatique.');
        return 'TRANSIENT_FAILURE';
      }
      setError(`${enrolled.error.message} Les actions locales sont conservées.`);
      return 'STOPPED';
    }

    const remote = await auth.crew.trips();
    if (!remote.ok) {
      if (remote.error.status === 401) {
        setNotice('Session expirée : les actions locales sont conservées pour la reconnexion.');
        router.replace('/connexion');
        return 'STOPPED';
      }
      if (isTransientApiError(remote.error)) {
        setNotice('Core API indisponible : voyages conservés, nouvelle tentative automatique.');
        return 'TRANSIENT_FAILURE';
      }
      setError(remote.error.message);
      return 'STOPPED';
    }
    const unassigned = await replaceTripSnapshots(remote.data.items);
    if (unassigned > 0) {
      setNotice(
        `${unassigned} action(s) locale(s) conservée(s) mais marquée(s) à vérifier : affectation retirée.`,
      );
    }
    await refreshLocal();
    return 'READY';
  }, [refreshLocal, router]);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    let retryAttempt = 0;
    let retryTimer: number | undefined;

    function scheduleRefresh(delay = 0) {
      if (!active || !navigator.onLine) return;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void validateOnline();
      }, delay);
    }

    async function validateOnline() {
      if (!active || !navigator.onLine || refreshing) return;
      refreshing = true;
      let result: RefreshResult;
      try {
        result = await refreshFromServer();
      } catch {
        result = 'STOPPED';
        if (active) setError('Le stockage local Crew est indisponible sur cet appareil.');
      } finally {
        refreshing = false;
      }

      if (!active || !navigator.onLine) {
        if (active) setOnline(false);
        return;
      }
      if (result === 'READY') {
        retryAttempt = 0;
        setError(null);
        setOnline(true);
        return;
      }

      setOnline(false);
      if (result === 'TRANSIENT_FAILURE') {
        retryAttempt += 1;
        scheduleRefresh(retryDelayMs(retryAttempt));
      } else {
        retryAttempt = 0;
      }
    }

    const onOnline = () => {
      setOnline(false);
      scheduleRefresh();
    };
    const onOffline = () => {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
      retryAttempt = 0;
      setOnline(false);
      setNotice('Mode hors ligne : les actions seront conservées sur cet appareil.');
    };

    void (async () => {
      try {
        await recoverInterruptedSync();
        const purged = await purgeExpiredData();
        if (!active) return;
        setOnline(false);
        await refreshLocal();
        if (purged.events > 0 || purged.trips > 0) {
          setNotice('Données locales expirées purgées.');
        }
        if (navigator.onLine) {
          await validateOnline();
        } else {
          const id = await deviceId();
          if (active) setDevice(id);
        }
      } catch {
        if (active) setError('Le stockage local Crew est indisponible sur cet appareil.');
      } finally {
        if (active) setBooting(false);
      }
    })();

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [refreshFromServer, refreshLocal]);

  useEffect(() => {
    if (!online || syncing) return;
    const retryable = events.filter((item) => item.status === 'PENDING');
    if (retryable.length === 0) return;
    const next = Math.min(...retryable.map((item) => Date.parse(item.nextAttemptAt)));
    const timer = window.setTimeout(
      () => void syncQueued(device ?? undefined),
      Math.max(0, next - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [device, events, online, syncing, syncQueued]);

  const pendingCount = useMemo(
    () => events.filter((item) => item.status === 'PENDING' || item.status === 'SYNCING').length,
    [events],
  );

  const selectedSnapshot = useMemo(
    () => trips.find((item) => item.trip.reference === selectedTrip) ?? null,
    [selectedTrip, trips],
  );

  const borderWaypoints = useMemo(() => {
    const waypoints =
      selectedSnapshot?.trip.waypoints.filter((waypoint) => waypoint.checkpointType === 'BORDER') ??
      [];
    return waypoints.map((waypoint) => {
      let state = (waypoint.borderState ?? 'PENDING') as BorderState;
      const local = events
        .filter(
          (item) =>
            item.tripReference === selectedTrip &&
            item.type === 'BORDER_EVENT' &&
            item.payload.routeWaypointId === waypoint.id &&
            (item.status === 'PENDING' || item.status === 'SYNCING'),
        )
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
      for (const item of local) {
        if (item.type === 'BORDER_EVENT' && nextBorderEvent(state) === item.payload.eventType) {
          state = item.payload.eventType;
        }
      }
      return { ...waypoint, effectiveState: state, nextEvent: nextBorderEvent(state) };
    });
  }, [events, selectedSnapshot, selectedTrip]);

  useEffect(() => {
    setCheckpointWaypointId((current) => {
      if (selectedSnapshot?.trip.waypoints.some((waypoint) => waypoint.id === current)) {
        return current;
      }
      return selectedSnapshot?.trip.waypoints[0]?.id ?? '';
    });
  }, [selectedSnapshot]);

  async function submitBoarding(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!selectedTrip) {
      setError('Aucun voyage affecté n’est disponible.');
      return;
    }
    if (selectedSnapshot?.trip.status !== 'SCHEDULED') {
      setError('L’embarquement n’est disponible qu’avant le départ du voyage.');
      return;
    }
    const payload = qrPayload.trim();
    if (!payload) {
      setError('Scannez ou saisissez un code d’embarquement.');
      return;
    }
    setRecording(true);
    try {
      await queueBoarding(selectedTrip, payload);
      setQrPayload('');
      setNotice('Embarquement enregistré sur cet appareil — synchronisation en attente.');
      await refreshLocal();
      if (online) await syncQueued(device ?? undefined, true);
    } finally {
      setRecording(false);
    }
  }

  async function submitCheckpoint(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!selectedTrip || !checkpointWaypointId) {
      setError('Sélectionnez un voyage et un checkpoint.');
      return;
    }
    setRecording(true);
    try {
      await queueTrackingCheckpoint(selectedTrip, checkpointWaypointId);
      setNotice('Checkpoint enregistré sur cet appareil — synchronisation en attente.');
      await refreshLocal();
      if (online) await syncQueued(device ?? undefined, true);
    } finally {
      setRecording(false);
    }
  }

  async function recordBorder(routeWaypointId: string, eventType: BorderEventType) {
    setError(null);
    setNotice(null);
    if (!selectedTrip || selectedSnapshot?.trip.status !== 'IN_PROGRESS') {
      setError('Les événements frontière sont disponibles uniquement pendant le voyage.');
      return;
    }
    setRecording(true);
    try {
      await queueBorderEvent(selectedTrip, routeWaypointId, eventType);
      setNotice('Événement frontière enregistré sur cet appareil — synchronisation en attente.');
      await refreshLocal();
      if (online) await syncQueued(device ?? undefined, true);
    } finally {
      setRecording(false);
    }
  }

  async function submitIncident(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!selectedTrip || !selectedSnapshot) {
      setError('Aucun voyage affecté n’est disponible.');
      return;
    }
    if (
      selectedSnapshot.trip.status !== 'SCHEDULED' &&
      selectedSnapshot.trip.status !== 'IN_PROGRESS'
    ) {
      setError('Un incident ne peut être déclaré que sur un voyage planifié ou en cours.');
      return;
    }
    const description = incidentDescription.trim();
    if (description.length < 10) {
      setError('Décrivez l’incident en au moins 10 caractères.');
      return;
    }
    const baggageReference = incidentBaggageReference.trim().toUpperCase();
    if (incidentType === 'BAGGAGE' && !baggageReference) {
      setError('La référence bagage est obligatoire pour un incident bagage.');
      return;
    }

    setRecording(true);
    try {
      await queueIncidentReport(selectedTrip, {
        incidentType,
        severity: incidentSeverity,
        description,
        ...(incidentLocation.trim() ? { locationLabel: incidentLocation.trim() } : {}),
        ...(incidentType === 'BAGGAGE' ? { baggageReference } : {}),
      });
      setIncidentDescription('');
      setIncidentLocation('');
      setIncidentBaggageReference('');
      setNotice('Incident enregistré sur cet appareil — synchronisation en attente.');
      await refreshLocal();
      if (online) await syncQueued(device ?? undefined, true);
    } finally {
      setRecording(false);
    }
  }

  async function retry(item: LocalCrewEvent) {
    await retryEvent(item.clientEventId);
    await refreshLocal();
    if (online) await syncQueued(device ?? undefined, true);
  }

  async function discard(item: LocalCrewEvent) {
    await discardEvent(item.clientEventId);
    await refreshLocal();
    setNotice('Événement local supprimé.');
  }

  async function logout() {
    setError(null);
    if (device && navigator.onLine) {
      await auth.crew.revokeDevice(device, 'Déconnexion explicite de la PWA');
    }
    await clearOfflineData();
    await auth.logout('crew');
    router.replace('/connexion');
  }

  if (booting) return <p role="status">Préparation de l’espace équipage…</p>;

  return (
    <div className="crew-workspace">
      <section className="crew-status" aria-label="État de la connexion et de la synchronisation">
        <div>
          <strong>{online ? 'En ligne' : 'Hors ligne'}</strong>
          <span className="et-tag">
            {syncing ? 'Synchronisation…' : `${pendingCount} en attente`}
          </span>
        </div>
        <div className="et-actions">
          <button
            type="button"
            className="et-button et-button--secondary"
            disabled={!online || syncing || pendingCount === 0}
            onClick={() => void syncQueued(device ?? undefined, true)}
          >
            Synchroniser
          </button>
          <button
            type="button"
            className="et-button et-button--secondary"
            onClick={() => void logout()}
          >
            Se déconnecter
          </button>
        </div>
      </section>

      {email ? (
        <p className="crew-device">
          Session : <span data-testid="session-email">{email}</span>
        </p>
      ) : null}

      <FormAlert message={error} />
      {notice ? (
        <FormStatus>
          <p>{notice}</p>
        </FormStatus>
      ) : null}

      <section className="crew-panel" aria-labelledby="crew-trip-title">
        <h2 id="crew-trip-title">Voyage affecté</h2>
        {trips.length === 0 ? (
          <p>Aucun voyage disponible dans le cache local.</p>
        ) : (
          <label className="et-field">
            Voyage
            <select
              aria-label="Voyage"
              className="et-select"
              value={selectedTrip}
              onChange={(event) => setSelectedTrip(event.target.value)}
            >
              {trips.map((item) => (
                <option key={item.assignmentId} value={item.trip.reference}>
                  {item.trip.reference} — {item.trip.route.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {trips
          .filter((item) => item.trip.reference === selectedTrip)
          .map((item) => (
            <dl className="crew-trip-facts" key={item.assignmentId}>
              <div>
                <dt>État</dt>
                <dd>{item.trip.status === 'IN_PROGRESS' ? 'En cours' : 'Planifié'}</dd>
              </div>
              <div>
                <dt>Départ prévu</dt>
                <dd>{formatDate(item.trip.plannedDepartureAt)}</dd>
              </div>
              <div>
                <dt>Arrivée prévue</dt>
                <dd>{formatDate(item.trip.plannedArrivalAt)}</dd>
              </div>
              <div>
                <dt>Véhicule</dt>
                <dd>{item.trip.vehicleCode ?? 'Non renseigné'}</dd>
              </div>
              <div>
                <dt>Cache valable jusqu’au</dt>
                <dd>{formatDate(item.snapshotExpiresAt)}</dd>
              </div>
            </dl>
          ))}
      </section>

      <section className="crew-panel" aria-labelledby="crew-board-title">
        <h2 id="crew-board-title">Embarquement</h2>
        <p className="et-hint">
          Scanner clavier ou saisie manuelle. Une action hors ligne est d’abord enregistrée
          localement, puis validée par le serveur lors de la reconnexion.
        </p>
        <form className="et-form crew-scan-form" onSubmit={submitBoarding}>
          <label className="et-field">
            Code QR passager
            <input
              className="et-input et-code"
              value={qrPayload}
              onChange={(event) => setQrPayload(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
              enterKeyHint="done"
            />
          </label>
          <button
            className="et-button crew-primary-action"
            type="submit"
            disabled={!selectedTrip || recording || selectedSnapshot?.trip.status !== 'SCHEDULED'}
          >
            Enregistrer l’embarquement
          </button>
        </form>
      </section>

      <section className="crew-panel" aria-labelledby="crew-tracking-title">
        <h2 id="crew-tracking-title">Checkpoint du voyage</h2>
        <p className="et-hint">
          Le passage est enregistré localement avec un identifiant idempotent et sera validé par le
          serveur lors de la synchronisation.
        </p>
        {selectedSnapshot?.trip.waypoints.length ? (
          <form className="et-form crew-scan-form" onSubmit={submitCheckpoint}>
            <label className="et-field">
              Étape / checkpoint
              <select
                className="et-select"
                value={checkpointWaypointId}
                onChange={(event) => setCheckpointWaypointId(event.target.value)}
              >
                {selectedSnapshot.trip.waypoints.map((waypoint) => (
                  <option key={waypoint.id} value={waypoint.id}>
                    {waypoint.sequence}. {waypoint.code} — {waypoint.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="et-button crew-primary-action"
              type="submit"
              disabled={!selectedTrip || !checkpointWaypointId || recording}
            >
              Enregistrer le passage
            </button>
          </form>
        ) : (
          <p>Aucun waypoint disponible dans le cache de ce voyage.</p>
        )}
      </section>

      <section className="crew-panel" aria-labelledby="crew-border-title">
        <h2 id="crew-border-title">Passages frontière</h2>
        <p className="et-hint">
          Journal opérationnel uniquement : ces actions ne constituent pas une décision douanière ni
          une autorisation d’entrée sur le territoire.
        </p>
        {borderWaypoints.length === 0 ? (
          <p>Aucun point frontière sur la route de ce voyage.</p>
        ) : (
          <ul className="crew-event-list">
            {borderWaypoints.map((waypoint) => (
              <li className="crew-event" key={waypoint.id}>
                <div>
                  <strong>
                    {waypoint.sequence}. {waypoint.code} — {waypoint.name}
                  </strong>
                  <div>État : {borderStateLabel(waypoint.effectiveState)}</div>
                </div>
                {waypoint.nextEvent ? (
                  <button
                    type="button"
                    className="et-button crew-primary-action"
                    disabled={recording || selectedSnapshot?.trip.status !== 'IN_PROGRESS'}
                    onClick={() => void recordBorder(waypoint.id, waypoint.nextEvent!)}
                  >
                    {borderEventLabel(waypoint.nextEvent)}
                  </button>
                ) : (
                  <span className="et-tag">Terminé</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="crew-panel" aria-labelledby="crew-incident-title">
        <h2 id="crew-incident-title">Déclarer un incident</h2>
        <p className="et-hint">
          La déclaration est d’abord enregistrée sur cet appareil. Elle reste disponible hors ligne
          et sera synchronisée avec le serveur dès que possible.
        </p>
        <form className="et-form crew-scan-form" onSubmit={submitIncident}>
          <label className="et-field">
            Type d’incident
            <select
              className="et-select"
              value={incidentType}
              onChange={(event) => setIncidentType(event.target.value as IncidentType)}
            >
              {INCIDENT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {INCIDENT_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="et-field">
            Sévérité
            <select
              className="et-select"
              value={incidentSeverity}
              onChange={(event) => setIncidentSeverity(event.target.value as IncidentSeverity)}
            >
              {INCIDENT_SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {INCIDENT_SEVERITY_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="et-field">
            Description opérationnelle
            <textarea
              className="et-input"
              rows={4}
              maxLength={2000}
              value={incidentDescription}
              onChange={(event) => setIncidentDescription(event.target.value)}
            />
          </label>
          <label className="et-field">
            Lieu (optionnel)
            <input
              className="et-input"
              value={incidentLocation}
              maxLength={160}
              autoComplete="off"
              onChange={(event) => setIncidentLocation(event.target.value)}
            />
          </label>
          {incidentType === 'BAGGAGE' ? (
            <label className="et-field">
              Référence bagage
              <input
                className="et-input et-code"
                value={incidentBaggageReference}
                maxLength={16}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                onChange={(event) => setIncidentBaggageReference(event.target.value)}
              />
            </label>
          ) : null}
          <button
            className="et-button crew-primary-action"
            type="submit"
            disabled={!selectedTrip || recording}
            data-testid="crew-report-incident"
          >
            Enregistrer l’incident
          </button>
        </form>
      </section>

      <section className="crew-panel" aria-labelledby="crew-queue-title">
        <div className="et-actions">
          <h2 id="crew-queue-title">File locale</h2>
          <span className="et-tag">{events.length} événement(s)</span>
        </div>
        {events.length === 0 ? (
          <p role="status">Toutes les actions sont synchronisées.</p>
        ) : (
          <ul className="crew-event-list">
            {events.map((item) => (
              <li key={item.clientEventId} className="crew-event">
                <div>
                  <strong>{eventLabel(item.status)}</strong>
                  <div className="et-code">{item.clientEventId.slice(0, 18)}…</div>
                  <small>
                    {item.type === 'PASSENGER_BOARDING'
                      ? 'Embarquement'
                      : item.type === 'BORDER_EVENT'
                        ? `Frontière · ${item.payload.eventType}`
                        : item.type === 'INCIDENT_REPORTED'
                          ? 'Incident · ' +
                            INCIDENT_TYPE_LABELS[item.payload.incidentType] +
                            ' · ' +
                            INCIDENT_SEVERITY_LABELS[item.payload.severity]
                          : 'Checkpoint'}{' '}
                    · {item.tripReference} · {formatDate(item.occurredAt)}
                    {item.errorCode ? ` · ${item.errorCode}` : ''}
                  </small>
                </div>
                {item.status === 'REJECTED' || item.status === 'CONFLICT' ? (
                  <div className="et-actions">
                    {item.status === 'REJECTED' ? (
                      <button
                        type="button"
                        className="et-button et-button--secondary"
                        onClick={() => void retry(item)}
                      >
                        Réessayer
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="et-button et-button--secondary"
                      onClick={() => void discard(item)}
                    >
                      Supprimer
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {device ? <p className="crew-device">Appareil : {device.slice(0, 18)}…</p> : null}
    </div>
  );
}
