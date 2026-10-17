import { describe, expect, it } from 'vitest';
import {
  afterNetworkFailure,
  applyServerResult,
  createBoardingEvent,
  createBorderEvent,
  createIncidentReportEvent,
  EVENT_TTL_MS,
  findPendingDuplicate,
  isExpired,
  MAX_RETRY_DELAY_MS,
  newClientEventId,
  orderEvents,
  partitionForAssignments,
  recoverInterruptedEvent,
  retryDelayMs,
  type LocalCrewEvent,
} from '../../lib/offline-model';

const NOW = new Date('2026-10-16T01:00:00.000Z');

type BoardingLocalEvent = Extract<LocalCrewEvent, { type: 'PASSENGER_BOARDING' }>;

function event(overrides: Partial<BoardingLocalEvent> = {}): BoardingLocalEvent {
  return {
    clientEventId: 'evt-00000001',
    type: 'PASSENGER_BOARDING',
    occurredAt: NOW.toISOString(),
    payload: { qrPayload: 'ETPAX1:ETQ-AAAAAAAAAAAAAAAA' },
    tripReference: 'ET-TEST-1',
    status: 'PENDING',
    errorCode: null,
    queuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + EVENT_TTL_MS).toISOString(),
    attempts: 0,
    nextAttemptAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('Crew offline queue model', () => {
  it('generates a stable opaque client event id and preserves it in the queued payload', () => {
    const uuid = '018f4f66-1234-7abc-8def-0123456789ab';
    expect(newClientEventId(() => uuid)).toBe(`evt-${uuid}`);
    const queued = createBoardingEvent(' et-test-1 ', ' etpax1:etq-aaaaaaaaaaaaaaaa ', {
      now: NOW,
      randomUUID: () => uuid,
    });
    expect(queued).toMatchObject({
      clientEventId: `evt-${uuid}`,
      tripReference: 'ET-TEST-1',
      occurredAt: NOW.toISOString(),
      payload: { qrPayload: 'ETPAX1:ETQ-AAAAAAAAAAAAAAAA' },
      status: 'PENDING',
      attempts: 0,
    });
    expect(Date.parse(queued.expiresAt) - NOW.getTime()).toBe(EVENT_TTL_MS);
  });

  it('queues border evidence with the same durable idempotent envelope', () => {
    const uuid = '018f4f66-1234-7abc-8def-0123456789ac';
    const queued = createBorderEvent(
      ' et-test-1 ',
      '01900000-0000-7000-8000-000000000010',
      'ARRIVED',
      { now: NOW, randomUUID: () => uuid },
    );
    expect(queued).toMatchObject({
      clientEventId: `evt-${uuid}`,
      type: 'BORDER_EVENT',
      tripReference: 'ET-TEST-1',
      occurredAt: NOW.toISOString(),
      payload: {
        routeWaypointId: '01900000-0000-7000-8000-000000000010',
        eventType: 'ARRIVED',
      },
      status: 'PENDING',
    });
    expect(
      findPendingDuplicate(
        [queued],
        createBorderEvent('ET-TEST-1', '01900000-0000-7000-8000-000000000010', 'ARRIVED', {
          now: NOW,
          randomUUID: () => '018f4f66-1234-7abc-8def-0123456789ad',
        }),
      ),
    ).toBe(queued);
    expect(
      findPendingDuplicate(
        [queued],
        createBorderEvent('ET-TEST-1', '01900000-0000-7000-8000-000000000010', 'CONTROL_STARTED', {
          now: NOW,
          randomUUID: () => '018f4f66-1234-7abc-8def-0123456789ae',
        }),
      ),
    ).toBeUndefined();
  });

  it('queues an incident report with normalized durable offline evidence', () => {
    const uuid = '018f4f66-1234-7abc-8def-0123456789af';
    const queued = createIncidentReportEvent(
      ' et-test-1 ',
      {
        incidentType: 'BREAKDOWN',
        severity: 'CRITICAL',
        description: '  Panne moteur immobilisante signalee par le conducteur.  ',
        routeWaypointId: '01900000-0000-7000-8000-000000000010',
        locationLabel: '  Aire de controle A1  ',
      },
      { now: NOW, randomUUID: () => uuid },
    );
    expect(queued.clientEventId).toBe('evt-' + uuid);
    expect(queued).toMatchObject({
      type: 'INCIDENT_REPORTED',
      tripReference: 'ET-TEST-1',
      occurredAt: NOW.toISOString(),
      payload: {
        incidentType: 'BREAKDOWN',
        severity: 'CRITICAL',
        description: 'Panne moteur immobilisante signalee par le conducteur.',
        routeWaypointId: '01900000-0000-7000-8000-000000000010',
        locationLabel: 'Aire de controle A1',
      },
      status: 'PENDING',
      attempts: 0,
    });
  });

  it('deduplicates only identical pending incident reports', () => {
    const first = createIncidentReportEvent(
      'ET-TEST-1',
      {
        incidentType: 'DELAY',
        severity: 'MEDIUM',
        description: 'Retard operationnel de quarante-cinq minutes.',
      },
      { now: NOW, randomUUID: () => '018f4f66-1234-7abc-8def-0123456789b0' },
    );
    const same = createIncidentReportEvent(
      'ET-TEST-1',
      {
        incidentType: 'DELAY',
        severity: 'MEDIUM',
        description: 'Retard operationnel de quarante-cinq minutes.',
      },
      { now: NOW, randomUUID: () => '018f4f66-1234-7abc-8def-0123456789b1' },
    );
    const changed = createIncidentReportEvent(
      'ET-TEST-1',
      {
        incidentType: 'DELAY',
        severity: 'HIGH',
        description: 'Retard operationnel de quarante-cinq minutes.',
      },
      { now: NOW, randomUUID: () => '018f4f66-1234-7abc-8def-0123456789b2' },
    );
    expect(findPendingDuplicate([first], same)).toBe(first);
    expect(findPendingDuplicate([first], changed)).toBeUndefined();
  });

  it.each(['PENDING', 'SYNCING'] as const)(
    'deduplicates an identical %s event before acknowledgement',
    (status) => {
      const existing = event({ status });
      expect(findPendingDuplicate([existing], event())).toBe(existing);
    },
  );

  it.each(['REJECTED', 'CONFLICT'] as const)(
    'allows an explicit new action after an older identical event is %s',
    (status) => {
      expect(findPendingDuplicate([event({ status })], event())).toBeUndefined();
    },
  );

  it('orders deterministically by queue time then client event id', () => {
    const rows = [
      event({ clientEventId: 'evt-c', queuedAt: '2026-10-16T01:00:01.000Z' }),
      event({ clientEventId: 'evt-b' }),
      event({ clientEventId: 'evt-a' }),
    ];
    expect(orderEvents(rows).map((row) => row.clientEventId)).toEqual(['evt-a', 'evt-b', 'evt-c']);
  });

  it('round-trips a persisted queue record without regenerating id, time or payload', () => {
    const original = event();
    const restored = JSON.parse(JSON.stringify(original)) as LocalCrewEvent;
    expect(restored).toEqual(original);
    expect(findPendingDuplicate([restored], original)?.clientEventId).toBe(original.clientEventId);
  });

  it('recovers an interrupted syncing record without changing its mutation', () => {
    const interrupted = event({ status: 'SYNCING', attempts: 2 });
    const recovered = recoverInterruptedEvent(interrupted);
    expect(recovered).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect(recovered.clientEventId).toBe(interrupted.clientEventId);
    expect(recovered.occurredAt).toBe(interrupted.occurredAt);
    expect(recovered.payload).toEqual(interrupted.payload);
  });

  it('backs off deterministically, caps delay and keeps network failures pending', () => {
    expect([1, 2, 3, 4, 20].map(retryDelayMs)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      MAX_RETRY_DELAY_MS,
    ]);
    let current: LocalCrewEvent = event();
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      current = afterNetworkFailure(current, NOW);
      expect(current).toMatchObject({
        attempts: attempt,
        status: 'PENDING',
        errorCode: 'NETWORK_ERROR',
      });
    }
    expect(Date.parse(current.nextAttemptAt) - NOW.getTime()).toBe(MAX_RETRY_DELAY_MS);
  });

  it('deletes an acknowledged event and retains explicit server conflicts', () => {
    expect(
      applyServerResult(event(), {
        clientEventId: 'evt-00000001',
        status: 'ACKNOWLEDGED',
        created: true,
        boardingReference: 'ETE-000000000001',
      }),
    ).toBeNull();
    expect(
      applyServerResult(event({ status: 'SYNCING' }), {
        clientEventId: 'evt-00000001',
        status: 'CONFLICT',
        errorCode: 'BOARDING_CLIENT_EVENT_ID_REUSED',
      }),
    ).toMatchObject({
      status: 'CONFLICT',
      errorCode: 'BOARDING_CLIENT_EVENT_ID_REUSED',
    });
    expect(
      applyServerResult(
        event({ status: 'SYNCING', attempts: 2 }),
        {
          clientEventId: 'evt-00000001',
          status: 'RETRY',
          errorCode: 'TOO_MANY_REQUESTS',
          retryAfterSeconds: 900,
        },
        NOW,
      ),
    ).toMatchObject({
      status: 'PENDING',
      attempts: 3,
      errorCode: 'TOO_MANY_REQUESTS',
      nextAttemptAt: new Date(NOW.getTime() + 900_000).toISOString(),
    });
  });

  it('expires records at their TTL and purges events for assignments no longer returned', () => {
    expect(isExpired(event(), new Date(NOW.getTime() + EVENT_TTL_MS - 1))).toBe(false);
    expect(isExpired(event(), new Date(NOW.getTime() + EVENT_TTL_MS))).toBe(true);
    const kept = event();
    const removed = event({ clientEventId: 'evt-2', tripReference: 'ET-REMOVED' });
    const partition = partitionForAssignments([removed, kept], new Set(['ET-TEST-1']));
    expect(partition.retained).toEqual([kept]);
    expect(partition.unassigned).toEqual([removed]);
  });

  it('does not merge different trips or QR payloads', () => {
    expect(
      findPendingDuplicate(
        [
          event({ tripReference: 'ET-OTHER' }),
          event({ payload: { qrPayload: 'ETPAX1:ETQ-BBBBBBBBBBBBBBBB' } }),
        ],
        event(),
      ),
    ).toBeUndefined();
  });
});
