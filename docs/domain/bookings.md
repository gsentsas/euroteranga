# Booking domain

> Implemented in PR-09 for provisional CUSTOMER holds and STAFF administration;
> PR-10 adds payment and confirmation ([payments.md](payments.md)).
> **NOT PRODUCTION DEPLOYED.** The repository contains no real journey, customer
> booking or passenger data. Browser and integration tests use synthetic data.

PR-09 lets an authenticated CUSTOMER temporarily retain seats for one journey
of a scheduled trip, as a **provisional hold**. PR-10 lets the CUSTOMER pay a
HELD booking through the payment abstraction (SANDBOX only, no real money). A
success makes the booking **CONFIRMED**: paid and confirmed, but still not a
ticket.

## Scope

Included:

- public stop lookup, trip search and segment-aware seat availability;
- CUSTOMER creation, listing, detail and cancellation of owned holds;
- STAFF list/detail with `booking.read`, and reasoned cancellation with
  `booking.manage`;
- exact price snapshots, historical seat maps and segment inventory;
- automatic logical expiry and transactional cleanup of expired locks;
- trip cancellation cascading to active holds in the same transaction;
- Booking, Client and OPS interfaces, plus real-browser coverage.

Deferred: passengers, guest booking, customer profiles, a real PSP, refunds,
tickets, QR codes, check-in, boarding, baggage, manifests, crew, dispatch,
promotions, coupons, fare classes and seat supplements.

## Model

| Object              | Purpose                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Booking`           | One CUSTOMER's hold for a trip and an exact origin/destination waypoint pair. It stores waypoint sequences, immutable fare snapshot, expiry and cancellation fields. |
| `BookingSeat`       | One historical seat selected from the trip's historical seat-map version. It is retained after release and records `releasedAt`.                                     |
| `SeatInventoryLock` | Operational occupancy of one seat on one trip segment. Released locks are deleted; the historical booking seat remains.                                              |

The authenticated CUSTOMER is the **booker**, not a passenger: `AuthIdentity`
≠ `CustomerProfile` ≠ `Passenger`. The CUSTOMER identity always comes from the
authenticated session (PostgreSQL checks realm CUSTOMER and status ACTIVE). It
is never accepted in a request body, and an email is never a booking key.
There is deliberately no Passenger model, no passenger data and no guest
booking in PR-09.

The public reference is `ETB-` followed by 12 cryptographically random
Crockford-base32 characters. Ambiguous letters are excluded. References are
immutable, unique and safe to show to the customer; internal ids remain UUIDv7.

## Derived status and expiry

Status is never stored separately:

1. `CANCELLED` when `cancelledAt` is set;
2. otherwise `CONFIRMED` when `confirmedAt` is set (PR-10: a payment
   succeeded; the hold expiry no longer matters);
3. otherwise `EXPIRED` when `holdExpiresAt <= database now()`;
4. otherwise `HELD`.

The API database clock is authoritative. `BOOKING_HOLD_TTL_SECONDS` (60–3600,
default 900) defines a new hold's lifetime, capped at the trip departure.
`BOOKING_MAX_SEATS_PER_HOLD` (1–20, default 8) is enforced by the service; the
browser limit is only an ergonomic mirror.

Expired holds need no scheduled job to become invalid: every occupancy query
requires a non-cancelled booking that is either CONFIRMED or an unexpired
hold. A CONFIRMED booking keeps its seats occupied after `holdExpiresAt`. The
cleanup never selects it, and PostgreSQL refuses to release its seats or delete
its locks. Before creating a hold, the
service locks and releases expired holds of that trip: `BookingSeat.releasedAt`
is set and their `SeatInventoryLock` rows are deleted. This bounded lazy cleanup
makes the seats reusable while keeping history.

## Segment inventory

A journey from route sequence `o` to `d` occupies the half-open interval
`[o, d)`: one lock for every segment sequence `o, o + 1, …, d - 1` and every
selected seat.

The unique PostgreSQL key
`(trip_id, seat_map_cell_id, segment_sequence)` is the final overbooking guard.
Consequences:

- the same seat cannot be held by overlapping journeys;
- adjacent journeys, such as `[1, 3)` and `[3, 5)`, may reuse it;
- different seats can be held independently;
- a multi-seat request is all-or-nothing in one transaction.

Availability is calculated from the trip's historical seat map and the active
locks intersecting the requested segment interval. Vehicle current layout and
browser state are never authorities.

## Price snapshot and exact money

The customer submits only the trip, the two route-waypoint ids and seat-map
cell ids. The server resolves the exact `FareEntry` from the trip's historical
fare-table version and snapshots:

- `fareEntryId`;
- `unitAmountMinor`;
- `currencyCode` and `currencyMinorUnit`.

The total is `unitAmountMinor × seatCount`, using integer/`BigInt` arithmetic.
No float, rounding, client-provided price, currency or fare is accepted. The
snapshot remains explainable after fare-table retirement.

## Transactions and lock order

Creation uses one transaction:

1. lock the trip `FOR SHARE` and re-check that it is scheduled, future, priced
   and has a historical seat map;
2. release expired holds for the trip in deterministic id order;
3. resolve the server fare and validate trip seat-map cells;
4. create the booking and booking seats;
5. insert segment locks ordered by seat-map cell id then segment (crossed
   multi-seat requests contend on their first common key: no deadlock);
6. append `BOOKING_HELD` to the audit trail.

A unique-lock race becomes `409 BOOKING_SEAT_UNAVAILABLE`; the entire
transaction rolls back, so partial multi-seat bookings cannot exist.

Cancellation locks the booking, marks it cancelled, releases all of its seats
and locks, and appends `BOOKING_CANCELLED` in one transaction. An audit failure
rolls back the business change. Concurrent repeated cancellation returns a
stable conflict rather than duplicating the action.

Trip cancellation keeps the existing trip-first lock hierarchy. It locks and
cancels every active hold, releases inventory and appends
`BOOKING_CANCELLED_BY_TRIP` before the trip's own audit event, all atomically.
A create-vs-trip-cancel race therefore ends with either a valid hold before an
atomic cascade, or `BOOKING_TRIP_NOT_BOOKABLE`; no hold survives a cancelled
trip.

### Lock hierarchy

PR-10 extends the hierarchy to **trip → payment → booking → booking seats →
seat locks** (details in [payments.md](payments.md)):

| Operation               | Locks, in order                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Hold creation           | trip `FOR SHARE` → expired bookings `FOR UPDATE` (by id) → new booking → booking seats → sorted locks      |
| Customer / STAFF cancel | the booking's PENDING payments `FOR UPDATE` (by id) → booking `FOR UPDATE` → booking seats → locks deleted |
| Trip cancellation       | trip `FOR UPDATE` → PENDING payments (by id) → non-cancelled bookings `FOR UPDATE` (by id) → seats → locks |

No path takes the trip after a booking, or a payment after a booking, so no
cycle can form; the concurrency tests run these races on PostgreSQL.

PR-10 rules for cancellations:

- a CONFIRMED booking cannot be cancelled by its CUSTOMER or by STAFF:
  `409 BOOKING_CONFIRMED`, until its succeeded payment is fully refunded (PR-22);
- a trip with a CONFIRMED booking cannot be cancelled:
  `409 TRIP_HAS_CONFIRMED_BOOKINGS`;
- cancelling a HELD booking also cancels its PENDING payment attempt
  (`PAYMENT_CANCELLED`), so that no attempt survives on a cancelled booking. If
  an attempt was created between the payment and booking locks, the
  cancellation answers `409 BOOKING_CANCEL_CONFLICT` instead of inverting the
  lock order.

## PostgreSQL guards

Migration `20261013210000_booking` enforces the rules for every writer:

- CHECKs: reference format, sequence order, positive amount, currency format
  and minor unit, hold after creation, cancellation consistency, release after
  creation, positive segment;
- `booking_guard`: created as an active hold by an ACTIVE CUSTOMER, on a
  SCHEDULED trip not yet departed with seat map and pricing (trip locked
  `FOR SHARE`), between stops of the trip's route version (boarding origin
  before alighting destination, matching sequences), with the exact fare entry
  of the trip's fare-table version and its exact price snapshot, and a hold
  ending no later than the departure; afterwards immutable except one
  cancellation of a still active hold; never deleted;
- `booking_seat_guard`: SEAT cells of the trip's historical seat map only,
  added to an active hold, never changed or deleted, released once after
  cancellation or expiry;
- `seat_inventory_lock_guard`: a lock matches its booking seat and trip,
  covers a segment of `[origin, destination)` of an active hold, is immutable,
  and can be deleted only once its hold is cancelled or expired;
- `TRUNCATE` refused on the three tables;
- `trip_lifecycle_guard` (`CREATE OR REPLACE`, PR-06 to PR-08 rules kept):
  a trip with active holds cannot become CANCELLED.

Migration `20261013230000_payments` (PR-10) replaces these functions, keeping
every PR-09 rule:

- bookings are created unconfirmed;
- `confirmedAt` is set once, on an active hold, by a succeeded payment;
- a confirmed booking can neither be cancelled nor release, gain or delete
  seats and locks;
- a trip with a confirmed booking cannot be cancelled.

## API

Public, unauthenticated reads under `/v1/booking`:

| Method | Path                                                                                             | Purpose                                                                    |
| ------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| GET    | `/stops?query&cursor&limit`                                                                      | Active stops of active countries.                                          |
| GET    | `/trips?originStopId&destinationStopId&departureFrom&departureTo&minAvailableSeats&cursor&limit` | Scheduled future trips with exact waypoint pair, fare and available count. |
| GET    | `/trips/:tripId/availability?originRouteWaypointId&destinationRouteWaypointId`                   | Historical layout and segment-aware availability.                          |
| GET    | `/trips/:tripId/itinerary`                                                                       | Planned itinerary of a bookable trip (UI-PUBLIC-2).                        |
| GET    | `/fleet`                                                                                         | Active vehicles, public facts only (UI-PUBLIC-2, `docs/domain/fleet.md`).  |

**Itinerary (UI-PUBLIC-2).** Only for a trip the search would show
(`SCHEDULED`, future departure, historical seat map); otherwise
`404 BOOKING_TRIP_NOT_BOOKABLE`. Cached 60 s (`public`). It returns the
trip reference, the route, and the waypoints in route order: kind (`STOP`
or `CHECKPOINT`), stop code, name, locality, timezone, country, boarding
and alighting flags and planned UTC times. **Technical checkpoints (fuel,
rest, crew change) are never returned**; borders, ports and ferry
terminals are. The assigned vehicle is included (code, name, model, year,
equipment) only while it is `ACTIVE`, else `null`; never its VIN or
registration. The website cuts the itinerary between the waypoints of the
journey it found in the search.

Authenticated CUSTOMER endpoints under `/v1/booking/bookings`:

| Method | Path                 | CSRF | Purpose                          |
| ------ | -------------------- | ---- | -------------------------------- |
| POST   | `/`                  | yes  | Create a provisional hold.       |
| GET    | `/`                  | no   | List only the caller's bookings. |
| GET    | `/:reference`        | no   | Read only the caller's booking.  |
| POST   | `/:reference/cancel` | yes  | Cancel an active owned hold.     |

Unknown and foreign references both return `404 BOOKING_NOT_FOUND`. This is
the IDOR boundary: no response reveals whether another CUSTOMER owns the
reference.

STAFF endpoints under `/v1/admin/bookings` require a STAFF session and
`ops.access`:

| Method | Path          | Permission              | Purpose                                         |
| ------ | ------------- | ----------------------- | ----------------------------------------------- |
| GET    | `/`           | `booking.read`          | Filtered list with derived status.              |
| GET    | `/:id`        | `booking.read`          | Detail, seats and opaque customer identity id.  |
| POST   | `/:id/cancel` | `booking.manage` + CSRF | Cancel with a mandatory 3–500 character reason. |

STAFF responses deliberately omit customer email. Identity information stays
behind the separate identity permissions.

| Code                                                                | HTTP | When                                                     |
| ------------------------------------------------------------------- | ---- | -------------------------------------------------------- |
| `BOOKING_NOT_FOUND`                                                 | 404  | unknown booking, or a booking of another customer        |
| `BOOKING_TRIP_NOT_BOOKABLE`                                         | 404  | unknown, DRAFT or CANCELLED trip                         |
| `BOOKING_TRIP_DEPARTED`                                             | 422  | the trip has departed                                    |
| `BOOKING_SEAT_MAP_NOT_CONFIGURED`, `BOOKING_PRICING_NOT_CONFIGURED` | 422  | the trip has no historical seat map / pricing            |
| `BOOKING_OD_INVALID`                                                | 422  | not a boarding stop before an alighting stop of the trip |
| `BOOKING_FARE_NOT_CONFIGURED`                                       | 404  | valid pair without a fare (no fallback)                  |
| `BOOKING_SEAT_INVALID`                                              | 422  | duplicate, non-SEAT or foreign seat-map cell             |
| `BOOKING_TOO_MANY_SEATS`                                            | 422  | more than `BOOKING_MAX_SEATS_PER_HOLD`                   |
| `BOOKING_SEAT_UNAVAILABLE`                                          | 409  | a seat is held on an overlapping segment                 |
| `BOOKING_CANCELLED`, `BOOKING_EXPIRED`                              | 409  | cancelling a cancelled or expired hold                   |
| `BOOKING_CONFIRMED`                                                 | 409  | cancelling a confirmed (paid) booking (PR-10)            |
| `BOOKING_CANCEL_CONFLICT`                                           | 409  | the booking changed during the cancellation              |

No raw Prisma or PostgreSQL error is ever returned.

## Permissions and audit

| Role                                                                | `booking.read` | `booking.manage` |
| ------------------------------------------------------------------- | -------------- | ---------------- |
| SUPER_ADMIN, DIRECTOR, OPS_MANAGER, BOOKING_AGENT, CUSTOMER_SUPPORT | yes            | yes              |
| DISPATCHER, COMPLIANCE_AGENT, FINANCE, AUDITOR                      | no             | no               |
| DRIVER, CREW (CREW realm)                                           | no             | no               |

Every `booking.manage` holder also holds `booking.read` (checked in the
database). AUDITOR keeps `audit.read` as its audit tool.

Audit actions, each in the same transaction as the change:
`BOOKING_HELD` (actor: the CUSTOMER), `BOOKING_CANCELLED` (CUSTOMER or STAFF,
with the reason), `BOOKING_CANCELLED_BY_TRIP` (the STAFF member cancelling the
trip). They carry the reference, trip, waypoints, seat labels, amounts and
reason, never an email, password, session, token or cookie.

## User interfaces

- **Booking**: origin, destination and date; server search; trip historical
  seat map; exact multi-seat total; CUSTOMER sign-in without losing selection;
  hold creation and a clearly labelled **Réservation provisoire** confirmation.
  A seat-race response reloads server availability and keeps selections that
  remain valid.
- **Client `/compte`**: owned HELD, CONFIRMED, EXPIRED and CANCELLED
  reservations, with server totals and cancellation of active holds. It reloads
  after mutation. From PR-10, HELD bookings can be paid, and CONFIRMED ones show
  their payment, without a cancellation button.
- **OPS `/bookings`**: navigation and reads need `booking.read`; cancellation
  controls exist only with `booking.manage`, require a reason, and remain
  protected by the API when called directly.

Sessions stay in the existing HttpOnly CUSTOMER/STAFF cookies. Tokens, CSRF
values and selections are not persisted to localStorage, sessionStorage or
URLs.

### Pre-filled search (UI-PUBLIC-1)

The public website's search form and departure cards open Booking with
search criteria only: `?from=PAR&to=DKR&date=YYYY-MM-DD&passengers=2`.

- `from` and `to` are stop codes, resolved to the exact active stop through
  the public stops API.
- `date` is a calendar day. The search covers that day in the **origin
  stop's timezone** (the date the website showed), for the form too. A stop
  without a known timezone falls back to UTC.
- `passengers` (1 to 8) only adds a reminder to choose that many seats; the
  server still decides the seat limit.
- With both stops and a valid date, the search runs at once.
- Invalid values are ignored without error: an unknown code, an impossible
  day (2030-02-31), a party size out of range or a missing stop. The search
  then simply stays to be completed.

No token, identity or seat selection travels in these links.

## Database migration and validation

Migration `20261013210000_booking` adds the three tables, constraints,
triggers, indexes, permissions and role grants. It upgrades a real PR-08
schema with `prisma migrate deploy`; historical PR-08 rows remain valid.

Coverage includes public search and availability, CUSTOMER auth/CSRF/
ownership/IDOR, overlapping and adjacent segments, expired reuse, multi-seat
atomicity, create-vs-trip-cancel, cancellation races, audit rollback,
historical seat map and fare table, exact price snapshot, direct database
invariants, PR-08→PR-09 upgrade, RBAC and Playwright flows.

`prisma migrate diff` covers tables, columns, indexes and foreign keys only. It
does not see CHECK constraints, triggers or functions: direct PostgreSQL tests
and mutation checks are the authority for those invariants.

See [ADR-026](../adr/ADR-026-segment-inventory-booking-holds.md).
