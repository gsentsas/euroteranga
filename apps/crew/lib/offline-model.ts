import type { CrewOfflineEvent, CrewSyncResult } from '@euroteranga/auth-client';

export type LocalEventStatus = 'PENDING' | 'SYNCING' | 'ACKNOWLEDGED' | 'REJECTED' | 'CONFLICT';

export type LocalCrewEvent = CrewOfflineEvent & {
  tripReference: string;
  status: LocalEventStatus;
  errorCode: string | null;
  queuedAt: string;
  expiresAt: string;
  attempts: number;
  nextAttemptAt: string;
};

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

export function createTrackingCheckpointEvent(
  tripReference: string,
  routeWaypointId: string,
  options: { now?: Date; randomUUID?: () => string } = {},
): LocalCrewEvent {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  return {
    clientEventId: newClientEventId(options.randomUUID),
    type: 'TRACKING_CHECKPOINT',
    occurredAt: timestamp,
    payload: { routeWaypointId },
    tripReference: tripReference.trim().toUpperCase(),
    status: 'PENDING',
    errorCode: null,
    queuedAt: timestamp,
    expiresAt: new Date(now.getTime() + EVENT_TTL_MS).toISOString(),
    attempts: 0,
    nextAttemptAt: timestamp,
  };
}

export function createBorderEvent(
  tripReference: string,
  routeWaypointId: string,
  eventType: 'ARRIVED' | 'CONTROL_STARTED' | 'CONTROL_COMPLETED' | 'DEPARTED',
  options: { now?: Date; randomUUID?: () => string } = {},
): LocalCrewEvent {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  return {
    clientEventId: newClientEventId(options.randomUUID),
    type: 'BORDER_EVENT',
    occurredAt: timestamp,
    payload: { routeWaypointId, eventType },
    tripReference: tripReference.trim().toUpperCase(),
    status: 'PENDING',
    errorCode: null,
    queuedAt: timestamp,
    expiresAt: new Date(now.getTime() + EVENT_TTL_MS).toISOString(),
    attempts: 0,
    nextAttemptAt: timestamp,
  };
}

export function createIncidentReportEvent(
  tripReference: string,
  input: {
    incidentType:
      | 'BREAKDOWN'
      | 'ACCIDENT'
      | 'DELAY'
      | 'BORDER'
      | 'CUSTOMS'
      | 'POLICE'
      | 'PASSENGER'
      | 'HEALTH'
      | 'BAGGAGE'
      | 'SECURITY'
      | 'WEATHER'
      | 'FERRY'
      | 'OTHER';
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    description: string;
    routeWaypointId?: string;
    locationLabel?: string;
    baggageReference?: string;
  },
  options: { now?: Date; randomUUID?: () => string } = {},
): LocalCrewEvent {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  return {
    clientEventId: newClientEventId(options.randomUUID),
    type: 'INCIDENT_REPORTED',
    occurredAt: timestamp,
    payload: {
      incidentType: input.incidentType,
      severity: input.severity,
      description: input.description.trim(),
      ...(input.routeWaypointId ? { routeWaypointId: input.routeWaypointId } : {}),
      ...(input.locationLabel ? { locationLabel: input.locationLabel.trim() } : {}),
      ...(input.baggageReference
        ? { baggageReference: input.baggageReference.trim().toUpperCase() }
        : {}),
    },
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

function samePayload(a: LocalCrewEvent, b: LocalCrewEvent): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'PASSENGER_BOARDING' && b.type === 'PASSENGER_BOARDING') {
    return a.payload.qrPayload === b.payload.qrPayload;
  }
  if (a.type === 'TRACKING_CHECKPOINT' && b.type === 'TRACKING_CHECKPOINT') {
    return a.payload.routeWaypointId === b.payload.routeWaypointId;
  }
  if (a.type === 'BORDER_EVENT' && b.type === 'BORDER_EVENT') {
    return (
      a.payload.routeWaypointId === b.payload.routeWaypointId &&
      a.payload.eventType === b.payload.eventType
    );
  }
  if (a.type === 'INCIDENT_REPORTED' && b.type === 'INCIDENT_REPORTED') {
    return (
      a.payload.incidentType === b.payload.incidentType &&
      a.payload.severity === b.payload.severity &&
      a.payload.description === b.payload.description &&
      a.payload.routeWaypointId === b.payload.routeWaypointId &&
      a.payload.locationLabel === b.payload.locationLabel &&
      a.payload.baggageReference === b.payload.baggageReference
    );
  }
  return false;
}

export function findPendingDuplicate(
  current: readonly LocalCrewEvent[],
  candidate: LocalCrewEvent,
): LocalCrewEvent | undefined {
  return current.find(
    (item) =>
      item.tripReference === candidate.tripReference &&
      samePayload(item, candidate) &&
      (item.status === 'PENDING' || item.status === 'SYNCING'),
  );
}
