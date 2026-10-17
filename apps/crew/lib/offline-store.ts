'use client';

import type { CrewSyncResult, CrewTripSnapshot } from '@euroteranga/auth-client';
import {
  afterNetworkFailure,
  afterTemporaryFailure,
  applyServerResult,
  createBoardingEvent,
  createBorderEvent,
  createTrackingCheckpointEvent,
  findPendingDuplicate,
  isExpired,
  orderEvents,
  partitionForAssignments,
  recoverInterruptedEvent,
  type LocalCrewEvent,
} from './offline-model';

export type { LocalCrewEvent } from './offline-model';

const DB_NAME = 'euroteranga-crew-offline-v1';
const DB_VERSION = 2;
const META = 'meta';
const TRIPS = 'trips';
const EVENTS = 'events';

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(TRIPS)) {
        db.createObjectStore(TRIPS, { keyPath: 'trip.reference' });
      }
      if (!db.objectStoreNames.contains(EVENTS)) {
        const events = db.createObjectStore(EVENTS, { keyPath: 'clientEventId' });
        events.createIndex('tripReference', 'tripReference');
        events.createIndex('status', 'status');
      }
    };
    open.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open Crew tab'));
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'));
  });
}

export async function deviceId(): Promise<string> {
  const db = await database();
  const tx = db.transaction(META, 'readwrite');
  const store = tx.objectStore(META);
  let value = (await request(store.get('deviceId'))) as string | undefined;
  if (!value) {
    value = `crew-${crypto.randomUUID()}`;
    store.put(value, 'deviceId');
  }
  await finished(tx);
  db.close();
  return value;
}

/**
 * Binds all local operational data to the authenticated server identity.
 * A different (or previously unknown) identity gets a fresh device and empty
 * stores; e-mail and session material are never persisted.
 */
export async function bindIdentity(identityId: string): Promise<boolean> {
  const db = await database();
  const tx = db.transaction([META, TRIPS, EVENTS], 'readwrite');
  const meta = tx.objectStore(META);
  const previous = (await request(meta.get('identityId'))) as string | undefined;
  const changed = previous !== identityId;
  if (changed) {
    meta.clear();
    tx.objectStore(TRIPS).clear();
    tx.objectStore(EVENTS).clear();
    meta.put(identityId, 'identityId');
  }
  await finished(tx);
  db.close();
  return changed;
}

/** Replaces authoritative assignments without deleting unsynchronized evidence. */
export async function replaceTripSnapshots(items: CrewTripSnapshot[]): Promise<number> {
  const db = await database();
  const tx = db.transaction([TRIPS, EVENTS], 'readwrite');
  const trips = tx.objectStore(TRIPS);
  const events = tx.objectStore(EVENTS);
  const allowed = new Set(items.map((item) => item.trip.reference));
  const queued = (await request(events.getAll())) as LocalCrewEvent[];
  const partition = partitionForAssignments(queued, allowed);
  let rejected = 0;
  for (const event of partition.unassigned) {
    if (event.status === 'PENDING' || event.status === 'SYNCING') {
      events.put({
        ...event,
        status: 'REJECTED',
        errorCode: 'CREW_TRIP_NOT_ASSIGNED',
      });
      rejected += 1;
    }
  }
  trips.clear();
  for (const item of items) trips.put(item);
  await finished(tx);
  db.close();
  return rejected;
}

export async function cachedTripSnapshots(): Promise<CrewTripSnapshot[]> {
  const db = await database();
  const tx = db.transaction(TRIPS, 'readonly');
  const rows = (await request(tx.objectStore(TRIPS).getAll())) as CrewTripSnapshot[];
  await finished(tx);
  db.close();
  const now = Date.now();
  return rows
    .filter((item) => Date.parse(item.snapshotExpiresAt) > now)
    .sort((a, b) =>
      (a.trip.plannedDepartureAt ?? '').localeCompare(b.trip.plannedDepartureAt ?? ''),
    );
}

export async function purgeExpiredData(now = new Date()): Promise<{
  events: number;
  trips: number;
}> {
  const db = await database();
  const tx = db.transaction([TRIPS, EVENTS], 'readwrite');
  const trips = tx.objectStore(TRIPS);
  const events = tx.objectStore(EVENTS);
  const snapshots = (await request(trips.getAll())) as CrewTripSnapshot[];
  const queued = (await request(events.getAll())) as LocalCrewEvent[];
  let expiredTrips = 0;
  let expiredEvents = 0;
  for (const snapshot of snapshots) {
    if (Date.parse(snapshot.snapshotExpiresAt) <= now.getTime()) {
      trips.delete(snapshot.trip.reference);
      expiredTrips += 1;
    }
  }
  for (const event of queued) {
    if (isExpired(event, now)) {
      events.delete(event.clientEventId);
      expiredEvents += 1;
    }
  }
  await finished(tx);
  db.close();
  return { events: expiredEvents, trips: expiredTrips };
}

export async function recoverInterruptedSync(): Promise<void> {
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  const store = tx.objectStore(EVENTS);
  const rows = (await request(store.getAll())) as LocalCrewEvent[];
  for (const row of rows) {
    if (row.status === 'SYNCING') store.put(recoverInterruptedEvent(row));
  }
  await finished(tx);
  db.close();
}

export async function queueBoarding(
  tripReference: string,
  qrPayload: string,
): Promise<LocalCrewEvent> {
  const event = createBoardingEvent(tripReference, qrPayload);
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  const store = tx.objectStore(EVENTS);
  const current = (await request(store.getAll())) as LocalCrewEvent[];
  const duplicate = findPendingDuplicate(current, event);
  if (duplicate) {
    await finished(tx);
    db.close();
    return duplicate;
  }
  store.add(event);
  await finished(tx);
  db.close();
  return event;
}

export async function queueTrackingCheckpoint(
  tripReference: string,
  routeWaypointId: string,
): Promise<LocalCrewEvent> {
  const event = createTrackingCheckpointEvent(tripReference, routeWaypointId);
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  const store = tx.objectStore(EVENTS);
  const current = (await request(store.getAll())) as LocalCrewEvent[];
  const duplicate = findPendingDuplicate(current, event);
  if (duplicate) {
    await finished(tx);
    db.close();
    return duplicate;
  }
  store.add(event);
  await finished(tx);
  db.close();
  return event;
}

export async function queueBorderEvent(
  tripReference: string,
  routeWaypointId: string,
  eventType: 'ARRIVED' | 'CONTROL_STARTED' | 'CONTROL_COMPLETED' | 'DEPARTED',
): Promise<LocalCrewEvent> {
  const event = createBorderEvent(tripReference, routeWaypointId, eventType);
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  const store = tx.objectStore(EVENTS);
  const current = (await request(store.getAll())) as LocalCrewEvent[];
  const duplicate = findPendingDuplicate(current, event);
  if (duplicate) {
    await finished(tx);
    db.close();
    return duplicate;
  }
  store.add(event);
  await finished(tx);
  db.close();
  return event;
}

export async function localEvents(): Promise<LocalCrewEvent[]> {
  const db = await database();
  const tx = db.transaction(EVENTS, 'readonly');
  const rows = (await request(tx.objectStore(EVENTS).getAll())) as LocalCrewEvent[];
  await finished(tx);
  db.close();
  return orderEvents(rows);
}

export async function markSyncing(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  const store = tx.objectStore(EVENTS);
  for (const id of ids) {
    const row = (await request(store.get(id))) as LocalCrewEvent | undefined;
    if (row) store.put({ ...row, status: 'SYNCING', errorCode: null });
  }
  await finished(tx);
  db.close();
}

export async function returnPending(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  const store = tx.objectStore(EVENTS);
  for (const id of ids) {
    const row = (await request(store.get(id))) as LocalCrewEvent | undefined;
    if (row && row.status === 'SYNCING') {
      store.put({ ...row, status: 'PENDING', nextAttemptAt: new Date().toISOString() });
    }
  }
  await finished(tx);
  db.close();
}

export async function applySyncResults(results: CrewSyncResult['results']): Promise<void> {
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  const store = tx.objectStore(EVENTS);
  for (const result of results) {
    const row = (await request(store.get(result.clientEventId))) as LocalCrewEvent | undefined;
    if (!row) continue;
    const next = applyServerResult(row, result);
    if (next) store.put(next);
    else store.delete(result.clientEventId);
  }
  await finished(tx);
  db.close();
}

export async function markNetworkFailure(ids: string[], now = new Date()): Promise<void> {
  if (ids.length === 0) return;
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  const store = tx.objectStore(EVENTS);
  for (const id of ids) {
    const row = (await request(store.get(id))) as LocalCrewEvent | undefined;
    if (row) store.put(afterNetworkFailure(row, now));
  }
  await finished(tx);
  db.close();
}

export async function markTemporaryFailure(
  ids: string[],
  errorCode: string,
  minimumDelayMs = 0,
  now = new Date(),
): Promise<void> {
  if (ids.length === 0) return;
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  const store = tx.objectStore(EVENTS);
  for (const id of ids) {
    const row = (await request(store.get(id))) as LocalCrewEvent | undefined;
    if (row) store.put(afterTemporaryFailure(row, errorCode, now, minimumDelayMs));
  }
  await finished(tx);
  db.close();
}

export async function markFailed(
  ids: string[],
  errorCode: string,
  status: 'REJECTED' | 'CONFLICT' = 'REJECTED',
): Promise<void> {
  if (ids.length === 0) return;
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  const store = tx.objectStore(EVENTS);
  for (const id of ids) {
    const row = (await request(store.get(id))) as LocalCrewEvent | undefined;
    if (row) store.put({ ...row, status, errorCode });
  }
  await finished(tx);
  db.close();
}

export async function discardEvent(clientEventId: string): Promise<void> {
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  tx.objectStore(EVENTS).delete(clientEventId);
  await finished(tx);
  db.close();
}

export async function retryEvent(clientEventId: string): Promise<void> {
  const db = await database();
  const tx = db.transaction(EVENTS, 'readwrite');
  const store = tx.objectStore(EVENTS);
  const row = (await request(store.get(clientEventId))) as LocalCrewEvent | undefined;
  if (row) {
    store.put({
      ...row,
      status: 'PENDING',
      errorCode: null,
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
    });
  }
  await finished(tx);
  db.close();
}

export async function clearOfflineData(): Promise<void> {
  const db = await database();
  const tx = db.transaction([META, TRIPS, EVENTS], 'readwrite');
  tx.objectStore(META).clear();
  tx.objectStore(TRIPS).clear();
  tx.objectStore(EVENTS).clear();
  await finished(tx);
  db.close();
}
