# Fleet domain

> Implemented in PR-05 for administration through the Core API and OPS.
> FLEET-MEDIA-1 adds MEDIA-1 photographs directly to the vehicle.
> **NOT PRODUCTION DEPLOYED.** The repository contains no real vehicle, VIN
> or registration plate.

The fleet core is the registry of the vehicles EURO TERANGA operates, and
their lifecycle. It answers "which vehicles exist, how are they identified,
and can they be used?". It does not plan or run anything.

## Deferred domains

PR-05 deliberately leaves these to later pull requests:

- **Trip**: assigning a vehicle to a trip or a route version.
- **SeatMap**: done in PR-07 (see below and [seat-maps.md](seat-maps.md));
  seat classes remain deferred to Pricing.
- **Maintenance**: workshop jobs, interventions, odometer, inspection due dates.
- **Documents**: registration certificates, insurance, technical inspection
  and other regulatory files.
- **Tracking**: GPS, telematics, live position.
- Crew assignment, dispatch, pricing, booking, passengers and payment.

`OUT_OF_SERVICE` is an operational state only: it carries a reason, not a
maintenance record.

## Model

`Vehicle` (table `vehicle`, UUIDv7 id, `snake_case`, UTC `timestamptz`):

| Field                   | Rules                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `code`                  | Internal stable identifier. Trimmed, uppercase, `[A-Z0-9][A-Z0-9_-]{0,31}`, unique.              |
| `name`                  | Optional operational name (e.g. "Teranga 01"). Trimmed, inner spaces collapsed, 1–80, unique.    |
| `vin`                   | Optional, uppercase, unique when present. **Shape check only** (see below).                      |
| `registrationPlate`     | Optional. Trimmed, uppercase, inner spaces collapsed, 1–16 characters, no control characters.    |
| `registrationCountryId` | Optional FK to the PR-04 `Country` (`ON DELETE RESTRICT`).                                       |
| `manufacturer`, `model` | Required, trimmed, 1–80 characters.                                                              |
| `modelYear`             | Optional. Database: 1950–2100. API: 1950 to next year.                                           |
| `status`                | `PLANNED`, `ACTIVE`, `OUT_OF_SERVICE`, `RETIRED`.                                                |
| `statusChangedAt`       | Last status change (null until the first one).                                                   |
| `retiredAt`             | Set if and only if `status = RETIRED`.                                                           |
| `amenities`             | On-board equipment (UI-PUBLIC-2): a distinct list of `vehicle_amenity` values, empty by default. |
| `primaryMediaId`        | Optional FK to an active MEDIA-1 asset; the main public photograph.                              |

`VehicleMedia` (`vehicle_media`) is the ordered gallery: at most six distinct
MEDIA-1 ids per vehicle, positions 0–5, with an optional `VehicleMediaKind`
(`EXTERIOR`, `INTERIOR`, `SEATS`, `LUGGAGE_HOLD`, `EQUIPMENT`, `CABIN`,
`OTHER`). It stores no upload and no URL.

**VIN.** The check is an application-level shape check: 17 characters from
the VIN alphabet (digits and letters except I, O and Q). The check digit and
national rules are not validated. A VIN that passes is well-formed, not
verified.

**Registration.** Plate formats differ per country, and some use non-Latin
scripts. There is no worldwide pattern. A plate is only meaningful with its
country: both are set together or both are empty. The pair
(country, plate) is unique, so the same plate may exist in two countries.

**On-board equipment (UI-PUBLIC-2).** `AIR_CONDITIONING`,
`RECLINING_SEATS`, `USB_CHARGING`, `WIFI`, `TOILET`, `ENTERTAINMENT`,
`WHEELCHAIR_ACCESS`. The fleet team ticks only what the coach really has,
in working order (OPS: "Équipements à bord"). The API stores each value
once, in this canonical order, and audits the change with the other
administrative data (`VEHICLE_UPDATED`). PostgreSQL refuses a null list
and duplicates (CHECK `vehicle_amenities_check`), even outside the API.
The website shows equipment only from this list: never from the CMS.

## Lifecycle

```
PLANNED ──► ACTIVE ◄──► OUT_OF_SERVICE
   │          │              │
   └──────────┴──────────────┴──► RETIRED (terminal)
```

| From             | Allowed to                  |
| ---------------- | --------------------------- |
| `PLANNED`        | `ACTIVE`, `RETIRED`         |
| `ACTIVE`         | `OUT_OF_SERVICE`, `RETIRED` |
| `OUT_OF_SERVICE` | `ACTIVE`, `RETIRED`         |
| `RETIRED`        | none                        |

- A vehicle is always created as `PLANNED`.
- The status changes only through `POST /vehicles/:id/status`, with a
  reason (3–500 characters). The general update rejects `status` and
  `retiredAt` (400).
- `RETIRED` is terminal: the row is frozen, including administrative data.
- There is no physical deletion: vehicles are retired.

### Enforcement in PostgreSQL

The migration `20261013090000_fleet_vehicles` enforces the rules for every
writer, including direct Prisma or SQL access:

- CHECK constraints: normalized code, VIN shape, normalized plate, plate and
  country together, model year range, `retired_at` set exactly when
  `RETIRED`, trimmed names;
- unique indexes: code, VIN, (country, plate);
- trigger `vehicle_lifecycle_guard`: insert as `PLANNED` only, the
  transition matrix above, `RETIRED` frozen, immutable id and creation date,
  `DELETE` refused;
- trigger `vehicle_no_truncate`: `TRUNCATE` refused.

Migration `20261021090000_vehicle_media` is additive. Its triggers also refuse
an archived asset, any gallery change on a retired vehicle, and archiving an
asset still referenced as a main or gallery photograph.

### Status transition

One transaction:

1. lock the vehicle row (`SELECT … FOR UPDATE`);
2. re-read its status;
3. if `expectedStatus` was sent and differs, refuse (409
   `VEHICLE_STATUS_CONFLICT`);
4. validate the transition (409 `VEHICLE_STATUS_TRANSITION_INVALID`);
5. update status, `statusChangedAt` and `retiredAt`;
6. write the `VEHICLE_STATUS_CHANGED` audit event with the reason.

If the audit insert fails, everything rolls back. Concurrent transitions are
serialized by the row lock. The second one sees the new status: it is either
still allowed, or refused. OPS sends `expectedStatus`, so a decision made on
a stale screen is refused rather than applied to a different state.

## Administration API

All endpoints are below `/v1/admin/fleet`. They require a STAFF session and
`ops.access`. Reads also require `fleet.read`; mutations require
`fleet.manage` and a session-bound CSRF token.

| Method | Path                     | Purpose                                                       |
| ------ | ------------------------ | ------------------------------------------------------------- |
| GET    | `/vehicles`              | Keyset pagination (`limit` 1–100, `cursor`), `status` filter  |
| GET    | `/vehicles/:id`          | Vehicle with its status history                               |
| POST   | `/vehicles`              | Register a vehicle (always `PLANNED`)                         |
| POST   | `/vehicles/:id`          | Update administrative data (not the status)                   |
| POST   | `/vehicles/:id/status`   | Status transition with reason and optional `expectedStatus`   |
| POST   | `/vehicles/:id/seat-map` | Current seat map (PR-07): `fleet.manage` + `seatmap.read`     |
| POST   | `/vehicles/:id/media`    | Replace main photo and gallery: `fleet.manage` + `media.read` |

There is no delete endpoint. Errors:

| Code                                | HTTP | When                                                |
| ----------------------------------- | ---- | --------------------------------------------------- |
| `VALIDATION_FAILED`                 | 400  | invalid input, or `status`/`retiredAt` in an update |
| `VEHICLE_NOT_FOUND`                 | 404  | unknown vehicle                                     |
| `COUNTRY_NOT_FOUND`                 | 404  | unknown registration country                        |
| `VEHICLE_IDENTIFIER_CONFLICT`       | 409  | duplicate code, VIN or (country, plate)             |
| `VEHICLE_RETIRED`                   | 409  | update of a retired vehicle                         |
| `VEHICLE_STATUS_TRANSITION_INVALID` | 409  | transition not in the matrix                        |
| `VEHICLE_STATUS_CONFLICT`           | 409  | `expectedStatus` differs from the current status    |
| `VEHICLE_REGISTRATION_INCOMPLETE`   | 422  | plate without country, or country without plate     |
| `VEHICLE_MEDIA_UNAVAILABLE`         | 422  | unknown or archived MEDIA-1 id                      |

## Public fleet read (UI-PUBLIC-2)

`GET /v1/booking/fleet` (no session, `Cache-Control: public, max-age=300`)
lists the **active** vehicles, ordered by name then code (at most 50), for
the "Nos bus" page and the coach of a trip page:

```json
{
  "items": [
    {
      "code": "…",
      "name": "…",
      "manufacturer": "…",
      "model": "…",
      "modelYear": 2024,
      "amenities": ["AIR_CONDITIONING"],
      "seatCount": 53,
      "primaryMedia": { "id": "…", "renditions": [] },
      "gallery": []
    }
  ]
}
```

`seatCount` is the number of SEAT cells of the current seat map (null
without one). The VIN, the registration, the status and the seat-map
identifiers are never returned. A planned, out-of-service or retired
vehicle is absent.

The public media shapes contain only MEDIA-1 presentation fields and WebP
rendition paths—never source hashes, storage keys or staff identities. The
bookable-trip search similarly returns `vehiclePrimaryMedia` for the actually
assigned active vehicle, so a departure card uses vehicle photo, then its CMS
journey fallback, then the existing placeholder.

## Seat map (PR-07)

A vehicle carries the seat-map version **currently configured** on it
(`seatMapVersionId`, with its computed capacity in API responses).

- It is changed only through `POST /vehicles/:id/seat-map`, with an optional
  `expectedSeatMapVersionId`; the general update rejects it.
- A new assignment needs a currently published version of an active seat map.
- Retiring the version later does not break the vehicle.
- Trips keep their own historical seat map: changing the vehicle's
  configuration never alters a trip.

See [seat-maps.md](seat-maps.md).

## Status history

`GET /vehicles/:id` returns the last 50 status changes. They are read from the
audit trail: date, from, to and reason. The history deliberately exposes no
actor identity to `fleet.read` holders. The full audit, with actors, stays
behind `audit.read`.

## Permissions

| Role                                     | `fleet.read` | `fleet.manage` |
| ---------------------------------------- | ------------ | -------------- |
| SUPER_ADMIN, DIRECTOR, OPS_MANAGER       | yes          | yes            |
| DISPATCHER, COMPLIANCE_AGENT, AUDITOR    | yes          | no             |
| BOOKING_AGENT, CUSTOMER_SUPPORT, FINANCE | no           | no             |
| DRIVER, CREW (CREW realm)                | no           | no             |

The grants are explicit rows in the PostgreSQL catalogue; there is no
wildcard. OPS hides the **Flotte** navigation without `fleet.read` and all
mutation controls without `fleet.manage`. This is display only: the API
re-checks every call.

Selecting vehicle media additionally needs `media.read`. `OPS_MANAGER` gets
that read-only library grant; upload/edit/archive still need `media.manage`.

## Audit

The domain reuses the PR-03 append-only audit trail, in the same transaction
as each change: `VEHICLE_CREATED`, `VEHICLE_UPDATED` (before/after) and
`VEHICLE_STATUS_CHANGED` (before/after status, reason in `metadata`). The
request id is kept, and snapshots go through the existing redaction.
`VEHICLE_MEDIA_CHANGED` records the main id and ordered gallery before/after.

## Tests

- Unit: the full 4×4 transition matrix and input normalization.
- Direct database tests (Prisma and raw SQL) for every constraint and
  trigger, including attempts to bypass the lifecycle.
- HTTP integration: permissions, CSRF, CRUD, duplicates, lifecycle, audit
  and request id, rollback on audit failure, concurrent transitions,
  pagination, absence of a delete endpoint.
- Browser tests with synthetic data (VINs prefixed `ZZZ`, no plates).

`prisma migrate diff` detects drift in what Prisma models: tables, columns,
indexes and foreign keys. It does **not** see CHECK constraints or triggers:
dropping `vehicle_model_year_range` on a migrated database still reports no
drift. Their presence and behaviour are proven by the direct database tests
instead, and each is covered by a mutation check.
