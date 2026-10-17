# Crew PWA and offline boarding (PR-18)

PR-18 lets an authenticated Crew member record a passenger boarding while the
network is unavailable and synchronize it later. It extends PR-14; it does not
create another check-in, boarding or departure engine.

## Operational flow

1. The Crew member signs in and enrolls this browser installation as a device.
2. The API returns only trips actively assigned to that identity.
3. The PWA stores the minimized assignment snapshot with an expiry.
4. A scanner-wedge or manual input records a typed `PASSENGER_BOARDING` event
   in IndexedDB before the local-success message is shown.
5. Refresh or browser restart recovers the same event and identifiers.
6. On reconnect, the PWA sends a bounded, ordered batch to the trip endpoint.
7. The API validates current authority and processes each event independently.
8. `ACKNOWLEDGED` removes the payload; `REJECTED` and `CONFLICT` remain visible
   for operator action. Network, quota and authentication failures retain the
   event as `PENDING` and pause retry safely.

## Server model

| Model                  | Purpose                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `crew_device`          | Public device identifier bound to one Crew identity, with enrollment, expiry and revocation. It is context, never authentication. |
| `crew_trip_assignment` | Revocable Crew-to-trip authorization with actor and reason history. Only one active pair is allowed.                              |
| `passenger_boarding`   | Existing append-only PR-14 boarding fact, extended with nullable Crew device and assignment provenance.                           |

Legacy STAFF boarding remains valid and has no Crew provenance. A Crew-created
boarding requires both provenance references, an active owner/device, an active
assignment to the QR-derived trip and a stable `clientEventId`. PostgreSQL
checks these invariants as a second barrier.

## API boundary

Crew routes are under `/v1/crew` and use the Crew origin/session, live RBAC and
CSRF on mutations:

- `GET /trips` and `GET /trips/:tripReference` — active, assigned,
  `SCHEDULED` trip snapshots only (`crew.trip.read`);
- `GET /devices/:deviceId`, `POST /devices/enroll` and
  `POST /devices/:deviceId/revoke` — the authenticated identity's own devices
  only (`crew.device.manage`);
- `POST /trips/:tripReference/events/sync` — a strictly typed, bounded batch of
  `PASSENGER_BOARDING` events with one result per input event
  (`crew.boarding.scan`). Route checkpoints use `crew.tracking.report`; operational border events use `crew.border.report`; `INCIDENT_REPORTED` uses `crew.incident.report`.

`DRIVER` and `CREW` receive the Crew-realm permissions required for assigned-trip boarding, tracking, border and incident reporting. They do not
receive STAFF `trip.read`, `boarding.read` or `boarding.scan`, and receive no
manifest, permit, readiness or departure permission. `SUPER_ADMIN` carries the
three keys only so the existing anti-escalation rule can provision Crew roles;
its STAFF session still cannot call a Crew-realm route.

STAFF with `ops.access` and `trip.manage` may list, create and revoke
assignments through `/v1/admin/trips/:tripId/crew-assignments`. Creating or
revoking an assignment is CSRF-protected and audited.

## Local state and wording

The queue states are `PENDING`, `SYNCING`, `ACKNOWLEDGED`, `REJECTED` and
`CONFLICT`. Creation time and event id define a stable order. Retries preserve
the original `occurredAt` and payload. The UI reports online/offline state,
pending count, current sync and actionable errors.

**« Enregistré sur cet appareil »** means only that IndexedDB committed the
event. **« Synchronisé avec EURO TERANGA »** means the Core API returned an
acknowledgement. These phrases are never interchangeable.

## Incident reports (PR-21)

PR-21 reuses this same IndexedDB queue for `INCIDENT_REPORTED`. The local payload
contains type, severity, bounded operational description and optional waypoint/location
or baggage reference. The original `clientEventId` and `occurredAt` survive reload and
retry. Server synchronization revalidates the live Crew assignment and enrolled device;
local persistence is not server acceptance. No claim, compensation or finance state is
created by the offline event.

## Boundary with dispatch

An acknowledged boarding may make an existing manifest and departure
fingerprint stale. Sync does not regenerate a manifest, calculate an alternate
readiness result, authorize a departure or transition a trip. All those actions
remain explicit server-side PR-15/PR-17 workflows.

### IndexedDB schema migration

The browser database keeps the stable name `euroteranga-crew-offline-v1`, but its schema is
versioned independently. PR-20 raises the IndexedDB schema to version 2 so installations that
previously created only part of the v1 stores are repaired in place: missing `meta`, `trips` or
`events` stores are created during `onupgradeneeded`. Existing compatible data is preserved.
Open tabs close their database handle on `versionchange` so another tab can complete the upgrade.
