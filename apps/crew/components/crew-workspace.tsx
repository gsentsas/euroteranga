'use client';

import type { ApiError, CrewOfflineEvent, CrewTripSnapshot } from '@euroteranga/auth-client';
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
  return {
    clientEventId: item.clientEventId,
    type: item.type,
    occurredAt: item.occurredAt,
    payload: { routeWaypointId: item.payload.routeWaypointId },
  };
}

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
                    {item.type === 'PASSENGER_BOARDING' ? 'Embarquement' : 'Checkpoint'} ·{' '}
                    {item.tripReference} · {formatDate(item.occurredAt)}
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
