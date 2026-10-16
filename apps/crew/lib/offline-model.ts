import type { CrewOfflineEvent, CrewSyncResult } from '@euroteranga/auth-client';

export type LocalEventStatus = 'PENDING' | 'SYNCING' | 'ACKNOWLEDGED' | 'REJECTED' | 'CONFLICT';

export interface LocalCrewEvent extends CrewOfflineEvent {
  tripReference: string;
  status: LocalEventStatus;
  errorCode: string | null;
  queuedAt: string;
  expiresAt: string;
  attempts: number;
  nextAttemptAt: string;
}

export const EVENT_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_RETRY_DELAY_MS = 30_000;

export function newClientEventId(randomUUID: () => string = () => crypto.randomUUID()): string {
  return `evt-${randomUUID()}`;
}

export function createBoardingEvent(
  tripReference: string,
  qrPayload: string,
  options: { now?: Date; randomUUID?: () => string } = {},
): LocalCrewEvent {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  return {
    clientEventId: newClientEventId(options.randomUUID),
    type: 'PASSENGER_BOARDING',
    occurredAt: timestamp,
    payload: { qrPayload: qrPayload.trim().toUpperCase() },
    tripReference: tripReference.trim().toUpperCase(),
    status: 'PENDING',
    errorCode: null,
    queuedAt: timestamp,
    expiresAt: new Date(now.getTime() + EVENT_TTL_MS).toISOString(),
    attempts: 0,
    nextAttemptAt: timestamp,
  };
}

export function orderEvents(events: readonly LocalCrewEvent[]): LocalCrewEvent[] {
  return [...events].sort(
    (a, b) =>
      a.queuedAt.localeCompare(b.queuedAt) || a.clientEventId.localeCompare(b.clientEventId),
  );
}

export function retryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

export function afterTemporaryFailure(
  event: LocalCrewEvent,
  errorCode: string,
  now = new Date(),
  minimumDelayMs = 0,
): LocalCrewEvent {
  const attempts = event.attempts + 1;
  const delay = Math.max(retryDelayMs(attempts), Math.max(0, minimumDelayMs));
  return {
    ...event,
    attempts,
    status: 'PENDING',
    errorCode,
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
  };
}

export function afterNetworkFailure(event: LocalCrewEvent, now = new Date()): LocalCrewEvent {
  return afterTemporaryFailure(event, 'NETWORK_ERROR', now);
}

export function applyServerResult(
  event: LocalCrewEvent,
  result: CrewSyncResult['results'][number],
  now = new Date(),
): LocalCrewEvent | null {
  if (result.status === 'ACKNOWLEDGED') return null;
  if (result.status === 'RETRY') {
    return afterTemporaryFailure(
      event,
      result.errorCode,
      now,
      Math.max(1, result.retryAfterSeconds) * 1_000,
    );
  }
  return {
    ...event,
    status: result.status,
    errorCode: result.errorCode,
  };
}

export function isExpired(event: Pick<LocalCrewEvent, 'expiresAt'>, now = new Date()): boolean {
  return Date.parse(event.expiresAt) <= now.getTime();
}

export function recoverInterruptedEvent(event: LocalCrewEvent): LocalCrewEvent {
  return event.status === 'SYNCING'
    ? { ...event, status: 'PENDING', nextAttemptAt: new Date(0).toISOString() }
    : event;
}

export function partitionForAssignments(
  events: readonly LocalCrewEvent[],
  allowedTripReferences: ReadonlySet<string>,
): { retained: LocalCrewEvent[]; unassigned: LocalCrewEvent[] } {
  const retained: LocalCrewEvent[] = [];
  const unassigned: LocalCrewEvent[] = [];
  for (const event of events) {
    (allowedTripReferences.has(event.tripReference) ? retained : unassigned).push(event);
  }
  return { retained, unassigned };
}

export function findPendingDuplicate(
  current: readonly LocalCrewEvent[],
  candidate: Pick<LocalCrewEvent, 'tripReference' | 'type' | 'payload'>,
): LocalCrewEvent | undefined {
  return current.find(
    (item) =>
      item.tripReference === candidate.tripReference &&
      item.type === candidate.type &&
      item.payload.qrPayload === candidate.payload.qrPayload &&
      (item.status === 'PENDING' || item.status === 'SYNCING'),
  );
}
