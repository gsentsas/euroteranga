# Tracking and public journey visibility (PR-19, TERANGA-COMFORT-1)

Tracking records operational observations for a trip and exposes a deliberately reduced public
projection. It is not a navigation system, a customs record, proof of border clearance, or a
guarantee of an arrival time.

The Core API remains the only business authority. Frontends never read the tracking tables
directly.

## Domain model

| Model | Purpose |
| --- | --- |
| `tracking_device` | Provider device identity attached to one vehicle. `provider_key + external_id` is unique. |
| `trip_tracking_config` | One mutable tracking policy per trip: enabled state, public visibility and optional tracking device. |
| `tracking_observation` | Append-only operational evidence from GPS, checkpoint, Crew, OPS or SYSTEM sources. |
| `tracking_public_token` | Revocable hash-only public capability for one trip. The raw token is returned only when issued. |

Tracking observations are evidence, not mutable current state. PostgreSQL rejects observation
updates/deletes and rejects truncation of the tracking history tables. Public-token identity is
immutable; revocation is final.

## Observation sources

The source enum is:

- `GPS` — provider position for the device configured on the trip;
- `CHECKPOINT` — an operational checkpoint observation recorded by STAFF;
- `CREW` — a waypoint report from an assigned Crew identity and an enrolled Crew device;
- `OPS` — an operational observation entered by STAFF;
- `SYSTEM` — a system-originated observation.

Coordinates are stored only when latitude and longitude are both present. PostgreSQL also enforces
coordinate ranges, non-negative accuracy/speed, heading below 360 degrees, source-specific
provenance and the required GPS/provider fields.

An observation timestamp cannot be more than five minutes in the future.

## Idempotence

Client-originated observations may carry a `clientEventId`. `(tripId, clientEventId)` is unique
and a SHA-256 payload fingerprint binds the identifier to the semantic payload. An exact replay
returns the existing observation; reusing the same identifier for different content is rejected as
`TRACKING_CLIENT_EVENT_ID_REUSED`.

Provider GPS observations use `(providerKey, providerObservationId)` as the provider idempotency
key. Reusing a provider observation identifier for different content is rejected as
`TRACKING_PROVIDER_EVENT_ID_REUSED`.

## Device and trip configuration

A tracking device belongs to one vehicle. Its provider identity is immutable. A trip may reference
a tracking device only when that device is active and belongs to the vehicle assigned to the trip.

The trip tracking configuration contains:

- `enabled`;
- `visibility`;
- optional `trackingDeviceId`.

Configuration changes are serialized per trip and audited in the same transaction. Tracking
permissions are deliberately separate from generic `trip.read`.

## Public visibility policy

The public capability has four visibility levels:

| Visibility | Public result |
| --- | --- |
| `HIDDEN` | The public token behaves as unavailable and returns the generic tracking-not-found response. |
| `CHECKPOINT_ONLY` | Traveller-visible stop/checkpoint progress may be shown; no coordinates are returned. |
| `APPROXIMATE` | Public coordinates are rounded to one decimal degree. Exact provider accuracy is not exposed. |
| `PRECISE` | The latest stored coordinates may be returned with `accuracyMeters`. |

A public checkpoint may come from `CHECKPOINT`, `CREW`, `OPS` or `SYSTEM`, but a checkpoint
with `travellerVisible=false` is never projected. Stops remain traveller-visible.

The public projection never returns internal observation ids, provider ids, STAFF/Crew identity
ids, Crew assignment ids or raw tracking rows.

`lastUpdatedAt` is visibility-safe: an observation or comfort event attached only to a hidden
waypoint must not advance the public timestamp. OPS keeps the complete operational timestamp.

## Public capability tokens

`POST /v1/admin/tracking/trips/:tripId/public-tokens` issues a cryptographically random opaque
token. Only its SHA-256 hash is persisted. The raw token is returned at issuance and cannot be
reconstructed from the database.

A token may have a future expiry. It can be revoked with a required reason. The public endpoint
returns the same generic `TRACKING_NOT_FOUND` response when a token is malformed, unknown,
expired, revoked, when tracking is disabled, or when visibility is `HIDDEN`. This avoids exposing
the reason a capability is unavailable.

Public endpoint:

- `GET /v1/tracking/:token` — no authenticated session; possession of the valid capability is the
  authorization.

Responses use `Cache-Control: no-store`.

## Provider health

Provider health is reported separately from the public position:

- a matching GPS observation within 15 minutes yields `UP`;
- an older matching GPS observation yields `STALE`;
- without a stored observation, a supported provider may report its own status, including
  `DEGRADED`;
- an unavailable or unsupported provider yields `UNAVAILABLE`.

Provider status does not change the visibility policy and does not authorize a more precise public
position.

## STAFF API and RBAC

All STAFF endpoints use the STAFF realm, authenticated sessions and deny-by-default RBAC.

Read operations require `tracking.read`:

- `GET /v1/admin/tracking/trips`;
- `GET /v1/admin/tracking/trips/:tripId`;
- `GET /v1/admin/tracking/trips/:tripId/comfort`;
- `GET /v1/admin/tracking/devices`.

Mutations require `tracking.manage` and CSRF protection:

- `POST /v1/admin/tracking/devices`;
- `POST /v1/admin/tracking/trips/:tripId/config`;
- `POST /v1/admin/tracking/trips/:tripId/observations`;
- `POST /v1/admin/tracking/trips/:tripId/public-tokens`;
- `POST /v1/admin/tracking/trips/:tripId/public-tokens/:tokenId/revoke`;
- `POST /v1/admin/tracking/trips/:tripId/comfort/events`.

Tracking mutations that change operational state are audited in the same database transaction as
the mutation.

The migration grants `tracking.read` to SUPER_ADMIN, DIRECTOR, OPS_MANAGER, DISPATCHER,
CUSTOMER_SUPPORT and AUDITOR. `tracking.manage` is granted to SUPER_ADMIN, DIRECTOR, OPS_MANAGER
and DISPATCHER.

## Crew reporting

Crew reporting is a separate authorization realm.

`POST /v1/crew/trips/:tripReference/tracking/checkpoints` requires:

- an authenticated Crew session;
- `crew.tracking.report`;
- CSRF;
- a currently active assignment to the trip;
- a currently enrolled, non-revoked Crew device;
- a waypoint belonging to the trip route.

The persisted observation records the Crew identity, assignment and device. DRIVER and CREW receive
`crew.tracking.report`; this permission does not grant STAFF `tracking.read` or
`tracking.manage`.

The shared offline Crew queue may preserve the original `clientEventId` and event timestamp for
later synchronization, but local persistence is never equivalent to server acceptance.

## TERANGA-COMFORT interaction

TERANGA-COMFORT reuses Tracking observations only to derive journey progress. Its public projection
contains traveller-visible current/next steps and pauses.

Comfort must never increase Tracking precision:

- `CHECKPOINT_ONLY` still returns no coordinates;
- `APPROXIMATE` remains rounded;
- hidden waypoints do not leak through comfort steps or public timestamps;
- no internal waypoint/event ids are returned to the traveller.

Planned times, pause durations and services remain indicative until an operational event confirms
or completes them.

## Operational and legal boundaries

Tracking expresses operational observations only. In particular:

- a border/checkpoint observation does not mean customs, police or immigration clearance;
- a reported position is not a contractual arrival commitment;
- provider health does not certify GPS accuracy;
- a public tracking link is a bearer capability and should be shared only with intended recipients;
- revoking a public token stops future use of that link but does not retract information already
  seen or copied by a recipient.

Border workflow semantics are documented separately in
[`docs/domain/borders.md`](./borders.md). Crew offline semantics are documented in
[`docs/domain/crew-offline.md`](./crew-offline.md). Traveller comfort semantics are documented in
[`docs/domain/comfort.md`](./comfort.md).
