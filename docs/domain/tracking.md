# Trip tracking (PR-19)

Tracking records where a trip is, and decides what may leave the
authenticated operational boundary. It never invents a position. A public
viewer sees only what the trip's visibility allows, through a revocable link.

## Model

| Entity                | Role                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TrackingDevice`      | A GPS unit of a vehicle at a provider (`providerKey`, `externalId`, unique together).                                                                                                 |
| `TripTrackingConfig`  | One per trip:<br>• `enabled` (default `false`);<br>• `visibility` (default `HIDDEN`);<br>• an optional device.<br>The STAFF identities that created and last changed it are recorded. |
| `TrackingObservation` | An append-only fact: a source, the observation time (`observedAt`), the server reception time (`receivedAt`), and an optional position or route waypoint.                             |
| `TrackingPublicToken` | A public link to one trip. Only the SHA-256 hash of the token is stored. Optional expiry; revocation records who and why.                                                             |

### Observation sources

| Source       | Written by                                                                   | Carries                                         |
| ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `GPS`        | A GPS provider adapter (provider observation id, deduplicated)               | position, accuracy, speed, heading              |
| `CHECKPOINT` | OPS (`tracking.manage`), always with a route waypoint                        | waypoint, optional position                     |
| `OPS`        | OPS (`tracking.manage`)                                                      | optional waypoint and/or position, label        |
| `CREW`       | Crew app (`crew.tracking.report`), online or replayed from the offline queue | waypoint passed by the assigned crew, device id |
| `SYSTEM`     | Reserved for platform-generated facts; no endpoint writes it today           | —                                               |

Duplicates are refused:

- `(tripId, clientEventId)` is unique, so a retried Crew or OPS event is
  recorded once;
- `(providerKey, providerObservationId)` is unique, so a provider replay is
  ignored;
- each observation stores a SHA-256 fingerprint of its payload.

### GPS provider status

**No GPS provider is connected today.** The registered adapter is
`UnavailableGpsProvider`, which supports no provider key. Positions can
still come from OPS observations. The public provider status is computed as
follows:

| Status        | When                                                             |
| ------------- | ---------------------------------------------------------------- |
| `UNAVAILABLE` | no device configured, or no supported provider                   |
| `UP`          | the last GPS observation of the device is at most 15 minutes old |
| `STALE`       | the last GPS observation is older than 15 minutes                |
| `DEGRADED`    | reported by a provider adapter (none today)                      |

## Visibility (what may be public)

| Visibility        | Public projection                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `HIDDEN`          | nothing: every token answers 404                                                                                             |
| `CHECKPOINT_ONLY` | the last route waypoint reached (stop or checkpoint, from `CHECKPOINT`, `CREW`, `OPS` or `SYSTEM` observations); no position |
| `APPROXIMATE`     | the last waypoint, and the last position rounded to 0.1° (about 11 km), without accuracy                                     |
| `PRECISE`         | the last waypoint, and the last exact position with its accuracy in metres                                                   |

`GPS_RECEIVED` never implies `GPS_PUBLIC`: a position is stored whatever
the visibility, but leaves the boundary only at `APPROXIMATE` or `PRECISE`.

The projection also gives:

- the trip reference and status;
- the route code and name;
- the planned departure and arrival;
- the provider status;
- `lastUpdatedAt`, the most recent of the waypoint and position times.

It never exposes passengers, crew, vehicle identifiers, devices, internal
ids or the observation history.

## Public links (fail-closed)

- **Issuing:** `POST /v1/admin/tracking/trips/:tripId/public-tokens`, with
  `tracking.manage` and CSRF. The token is 32 CSPRNG bytes in base64url
  (43 characters). It is returned **once**; only its hash is stored. An
  optional `expiresAt` must be in the future.
- **Revoking:** `POST …/public-tokens/:tokenId/revoke` with a reason (3 to
  255 characters). Both issuing and revoking are audited.
- **Reading:** `GET /v1/tracking/:token`, without a session. It answers the
  same `404 TRACKING_TOKEN_NOT_FOUND` when:
  - the token is malformed (checked before any database access);
  - the token is unknown;
  - the token is revoked or expired;
  - tracking is disabled for the trip;
  - visibility is `HIDDEN`.

  A link therefore never reveals whether a trip exists.

- **Tracking website:** with SEO-1, `tracking.euroteranga.com/<token>`
  answers a real 404 for any path that is not a well-formed token, so
  `robots.txt` and typos never reach the API.

## Operations

| Endpoint (`/v1/admin/tracking`)                 | Permission                          | Purpose                                                            |
| ----------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `GET /trips`, `GET /trips/:tripId`              | `tracking.read`                     | Scheduled and in-progress trips, configuration, observations       |
| `GET /devices`, `POST /devices`                 | `tracking.read` / `tracking.manage` | GPS devices of vehicles                                            |
| `POST /trips/:tripId/config`                    | `tracking.manage`                   | Enable, choose the visibility and the device                       |
| `POST /trips/:tripId/observations`              | `tracking.manage`                   | `CHECKPOINT` or `OPS` observation, idempotent with `clientEventId` |
| `POST /trips/:tripId/public-tokens`, `…/revoke` | `tracking.manage`                   | Public links                                                       |

Crew (`/v1/crew/trips/:tripReference/tracking/checkpoints`,
`crew.tracking.report`) reports the waypoint passed by an assigned crew
member from an enrolled device. It is replayed safely from the offline
queue.

## Limits

- **No live GPS:** a provider adapter and a contract with the provider are
  owner decisions. The status stays `UNAVAILABLE` until then.
- **No delay projection:** the projection shows facts and the planned
  times, never an estimated arrival.
- **Retention:** observation retention is part of the open data-retention
  policy (audit B5).
