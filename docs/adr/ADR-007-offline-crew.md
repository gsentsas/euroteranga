# ADR-007 — Offline Crew operations

- **Status:** Accepted
- **Scope:** PR-18

## Context

Boarding is performed in places where connectivity can disappear. Losing a
scan on a refresh is operationally unsafe, but letting a browser decide that a
passenger or a trip is authorized would create a second source of truth.
PR-14 already owns boarding validation and PostgreSQL exact-once constraints;
PR-17 alone owns departure readiness and dispatch.

## Decision

`apps/crew` is an installable PWA with a small, persistent IndexedDB queue. A
scan is first written locally with a cryptographically random, stable
`clientEventId`, the enrolled `deviceId`, the selected assigned trip and the
operator time. Only then may the UI say **« Enregistré sur cet appareil »**.
The record is sent unchanged on every retry.

Foreground synchronization runs at startup, on reconnect and on explicit user
request. Events are processed in deterministic creation order with bounded
backoff. The queue distinguishes `pending`, `syncing`, `acknowledged`,
`rejected` and `conflict`; an interrupted `syncing` record is recoverable.
Only a server acknowledgement permits **« Synchronisé avec EURO TERANGA »**
and removal of the mutation payload.

The Core API remains the only authority. Every sync revalidates the Crew
session, live permission, active enrolled device, active trip assignment,
trip state and every PR-14 boarding gate. PostgreSQL serializes concurrent
scans and enforces one boarding per check-in plus uniqueness of
`(device_id, client_event_id)`. The same key and canonical payload replay the
original success; a changed payload is an explicit conflict.

Crew capabilities are separate from STAFF capabilities:
`crew.trip.read`, `crew.device.manage` and `crew.boarding.scan`. The `DRIVER`
and `CREW` roles hold exactly this PR-18 set; it grants neither STAFF
`trip.read`/`boarding.scan` nor any departure capability.

The service worker caches only same-origin application shell and immutable
static assets. It never handles or caches `/v1`, authentication, API responses
or queued business data. No background-sync capability is required: the
portable foreground path is authoritative.

The local snapshot is deliberately minimal. It contains assigned trip display
data and opaque boarding events, not a passenger manifest, names, dates of
birth, documents, passwords, session cookies or CSRF values. Records expire
and are purged on logout and when the server reports that an assignment ended
or became unauthorized.

## Consequences

- An offline scan is durable evidence awaiting validation, never a boarding
  fact until the API acknowledges it.
- Revocation cannot reach a disconnected browser immediately. Reconnection
  always rechecks authority, while TTLs and purge rules bound local exposure.
- IndexedDB is plaintext to same-origin JavaScript. Browser-side encryption
  cannot protect against same-origin XSS without introducing another local
  secret, so minimization, short retention and XSS prevention are the controls.
- Crew has no offline departure/readiness action. PR-17 remains the sole
  dispatch implementation.
- Scanner-wedge/manual entry is supported. Camera capture is not enabled while
  the shared permissions policy deliberately sets `camera=()`.

## Alternatives rejected

- **Direct database access or local readiness:** breaks the Core API authority
  and cannot safely observe current revocations or facts.
- **Cache API responses in the service worker:** risks retaining passenger and
  authentication data outside the bounded queue.
- **Memory-only queue:** loses scans on refresh or process termination.
- **Claiming browser encryption at rest:** gives a false guarantee against the
  same JavaScript origin that must decrypt and synchronize the data.
