# Crew offline security and privacy

The disconnected browser is an untrusted, temporarily stale client. Local
state improves durability only; it never carries authorization from one moment
to another. The Core API and PostgreSQL remain authoritative.

## Data minimization

IndexedDB may contain only:

- a random public `deviceId`, the opaque authenticated identity id used only
  to detect an account change, and non-secret local metadata;
- minimized assigned-trip display fields and their server expiry;
- a random `clientEventId`, trip reference, event type, original operator time,
  opaque boarding QR payload, state, bounded retry metadata and safe error code.

It must not contain a password, session cookie, CSRF value, API token, server
secret, e-mail, passenger name, birth date, document data, payment data,
manifest or readiness snapshot. The opaque QR is retained only while needed to
synchronize or display an unresolved rejection and is deleted after ACK or
purge.

The service worker owns no business store. It bypasses `/v1` and never caches
API/auth responses. Cookies remain `HttpOnly`; CSRF is fetched into memory for
the live mutation and is never queued.

## Server controls on every synchronization

The API checks, in order:

1. allowed Crew origin, live non-expired/non-revoked Crew session and CSRF;
2. live `crew.boarding.scan` permission;
3. device ownership, active enrollment and expiry;
4. active assignment to the exact trip in the URL and QR-derived boarding;
5. `SCHEDULED` trip state and every current PR-14 gate;
6. payload schema, operator-time bounds and exact-once idempotency.

Database foreign keys, partial uniqueness, row locks, append-only guards and
boarding trigger repeat the critical identity/device/assignment/trip checks.
Client flags or cached permissions are display hints only.

## Permission boundary

The Crew API deliberately does not reuse STAFF permissions:

| Permission           | Scope                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| `crew.trip.read`     | Read only live `SCHEDULED` trips actively assigned to the authenticated Crew identity. |
| `crew.device.manage` | Inspect, enroll and revoke only devices owned by that identity.                        |
| `crew.boarding.scan` | Synchronize typed boarding events for an actively assigned trip and owned device.      |

`DRIVER` and `CREW` hold all three. `SUPER_ADMIN` also holds the keys only for
role anti-escalation, but the STAFF/CREW realm guard prevents a STAFF session
from using `/v1/crew`. None of these permissions grants STAFF boarding,
manifest, permit, readiness or departure access.

## Retention and purge

- Startup deletes expired snapshots and terminal local records beyond their
  short retention and recovers interrupted `syncing` work.
- Logout attempts server device revocation when online, then purges local Crew
  data even if the network call fails.
- A fresh assignment response purges trips that are completed, cancelled,
  expired or no longer assigned. An unauthorized sync pauses and removes data
  according to the explicit logout/re-authentication path; it never silently
  claims success.
- Retry is bounded and uses backoff. Business rejections and conflicts require
  operator action and do not loop forever.

## Honest browser-security boundary

IndexedDB is not encrypted by this application. Platform disk encryption may
protect a powered-off device, but same-origin JavaScript can read data that the
PWA can read. Encrypting with a key stored by the same origin would not defend
against same-origin XSS. The controls are CSP/header hygiene, dependency
review, no raw HTML injection, strict minimization, TTL and explicit purge.

There is an unavoidable revocation window while fully offline: the device
cannot learn that a role, assignment, session or device was revoked. Cached
screens therefore say only that an event is stored locally. The first sync
rechecks all authority and rejects stale work; no offline action can authorize
departure.

## Incident response

Suspend/disable the identity or revoke its roles, session, assignment and
device server-side. Those controls take effect on the next request. Treat a
lost unlocked device as potentially exposing its minimal unacknowledged QR
queue until local TTL/browser-data removal; never describe remote revocation as
remote erasure of an offline browser.
