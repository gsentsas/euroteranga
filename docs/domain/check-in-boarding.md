# Check-in and boarding (PR-14)

PR-14 checks a traveller in, then boards them, for one **booking passenger**.
A booking passenger is one real person on one confirmed booking of one
concrete trip. The same person can have several trips with different
check-in states; nothing in PR-14 works on a `Passenger` without its journey.

```
BookingPassenger → seat → six readiness gates → CHECKED_IN → boarding QR → scan → BOARDED
```

**Boundaries:**

- **PR-14** checks a traveller in and boards them.
- **PR-15** owns manifests: no PDF, CSV or departure snapshot here.
- **PR-17** owns whole-trip readiness, dispatch and departure authorization.
- **PR-18** owns the offline Crew PWA, device enrollment and sync. PR-14 only prepares the server for it with `deviceId`, `clientEventId` and `occurredAt`.

Some states sound alike but are different facts:

- passenger `CHECKED_IN` is not baggage `CHECKED_IN` (PR-13 has its own workflow);
- passenger `BOARDED` does not mean the trip may depart;
- the boarding QR is not a ticket, a proof of payment, an identity document or a regulatory approval.

## Model

| Table                    | Role                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `booking_passenger_seat` | One seat per booking passenger and one passenger per booked seat. It links an existing, unreleased `BookingSeat` of the same booking.                                                      |
| `passenger_check_in`     | The one append-only check-in of a booking passenger, with a minimized readiness snapshot, a readiness fingerprint and the opaque boarding credential.                                      |
| `passenger_boarding`     | The one append-only boarding of a check-in: `boarded_at` (server time), `boarded_by_identity_id`, `device_id`, optional `client_event_id`, `occurred_at` (operator time) and fingerprints. |

### Seat assignment

PR-09 stays the seat inventory authority: an assignment creates, releases and prices nothing.

PostgreSQL guarantees:

- **Same booking:** the composite foreign key `(booking_seat_id, booking_id) → booking_seat(id, booking_id)` proves the seat belongs to the booking.
- **Booked passenger:** the composite foreign key `(booking_id, passenger_id) → booking_passenger` proves the passenger is on that booking.
- **Unreleased seat:** the trigger takes a share lock on the booked seat and refuses a released one.
- **One-to-one:** the primary key gives one seat per booking passenger, and a unique `booking_seat_id` gives one passenger per seat.
- **Frozen at check-in:** the seat can change until check-in, never afterwards (trigger, plus the check-in foreign key with `ON UPDATE RESTRICT`).
- **No deletion:** assignments are never deleted.
- **Actor:** only the active booking customer or active STAFF can assign.

The API accepts only a seat label (`{ "seatLabel": "1A" }`) of a seat already booked on the same booking.

## Readiness gates

`checkin-readiness/1` is a pure, deterministic function of facts that the server reads from PostgreSQL. The browser supplies nothing.

| Gate         | Passes when                                                                                                                                                 | Blocker codes                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOOKING`    | The booking is confirmed and not cancelled, and the trip is `SCHEDULED`.                                                                                    | `BOOKING_NOT_CONFIRMED`, `BOOKING_CANCELLED`, `TRIP_NOT_SCHEDULED`                                                                                  |
| `PAYMENT`    | The booking has its PR-10 `SUCCEEDED` payment. At most one exists; it is final and is what confirmed the booking.                                           | `PAYMENT_NOT_SUCCEEDED`                                                                                                                             |
| `DOCUMENTS`  | The current PR-12 evaluation's evidence is still technically `ACCEPTED`, and its document findings are satisfied (or settled by a COMPLIANT review).        | `DOCUMENTS_NOT_VERIFIED`, `DOCUMENTS_NOT_ACCEPTED`, `DOCUMENTS_INCOMPLETE`, `DOCUMENTS_REVIEW_REQUIRED` (pending review)                            |
| `COMPLIANCE` | The PR-12 status is `COMPLIANT_BY_RULES` (current machine PASS) or `COMPLIANT` (current head review).                                                       | `COMPLIANCE_MISSING`, `COMPLIANCE_STALE`, `COMPLIANCE_REVIEW_REQUIRED` (pending review), `COMPLIANCE_NEEDS_INFORMATION`, `COMPLIANCE_NON_COMPLIANT` |
| `SEAT`       | A seat is assigned and it is not released.                                                                                                                  | `SEAT_NOT_ASSIGNED`, `SEAT_RELEASED`                                                                                                                |
| `BAGGAGE`    | No bag of the booking passenger has an active exception. `REMOVED` bags are history, zero bags is valid and weight is not a condition (there is no policy). | `BAGGAGE_EXCEPTION_ACTIVE` (pending review, with the bag reference)                                                                                 |

The response is `{ eligible, checks[], blockers[] }`:

- **`checks`:** one entry per gate, in a fixed order, with a status of `PASS`, `BLOCKED` or `PENDING_REVIEW`.
- **`blockers`:** the stable codes (plus a business reference where useful).
- **`eligible`:** true only when no gate reports a blocker.

The UIs map the codes to text (« OK », « À régulariser », « À vérifier », next actions). They never decide anything.

**No document rule is coded in PR-14.** "Documents OK" is never "must have a passport". It reuses the current PR-12 evaluation:

- a rule with `NO_DOCUMENT_REQUIRED` passes without any file;
- a `QUARANTINED` or `REJECTED` file is never valid evidence.

Compliance is read through `ComplianceEvaluationService.currentCompliance()`. It applies the same status, staleness and head review as every PR-12 view, with no new engine and no override.

## Check-in

- **Routes:**
  - CUSTOMER: `POST /v1/booking/bookings/:booking/passengers/:passenger/check-in`.
  - STAFF (`checkin.manage`): `POST /v1/admin/check-in/bookings/:booking/passengers/:passenger/check-in`.

  The body is empty: a strict schema refuses any status, gate, actor, device or override field.

- **Transaction:** lock the booking passenger row, derive every gate, refuse with `409 CHECK_IN_NOT_READY` and `details.blockers` when one fails, otherwise create the check-in and its credential, write the audit event and commit. Nothing is half-created.
- **Idempotent:** a repeated request returns the existing check-in (`created: false`).
- **At most one:** PostgreSQL allows one check-in per booking passenger (`UNIQUE (booking_id, passenger_id)`).
- **Append-only:** there is no un-check-in in PR-14.
- **Database re-checks:** the trigger re-checks the confirmed active booking, the `SCHEDULED` trip, the succeeded payment, the unreleased assigned seat, and the latest compliance evaluation of the same passenger with a `PASS` result or a current `COMPLIANT` head review. The actor must be the active booking customer or active STAFF. `checked_in_at` is the server clock.
- **No staff override:** STAFF go through exactly the same gates. There is no force, ignore or skip.

`GET .../check-in-readiness` and the overviews compute the gates without any side effect.

### Snapshot and fingerprint

- **Snapshot:** a minimized proof of why the check-in was allowed:
  - booking, trip and payment references and statuses;
  - the seat label;
  - the compliance evaluation reference, status and review decision;
  - evidence references and statuses;
  - the active bag count and blocking bags;
  - each gate status.

  It holds no name, birth date, document number, file, raw facts or scanner output.

- **Fingerprint:** a SHA-256 of every fact that can change the authorization:
  - booking, trip, payment, the seat id and release;
  - the compliance status, evaluation identity and fingerprints, and the head review;
  - evidence statuses and blocking bags.

  A bag moving `REGISTERED → CHECKED_IN → LOADED` without an exception does not change it.

## Staleness and boarding

At every scan, every gate is derived again.

- **Stale:** a check-in whose current gates are blocked is stale. Boarding is refused with `409 CHECK_IN_STALE` and the current blockers, and the refusal is audited. Examples:
  - compliance became stale (for example a new document was uploaded);
  - a blocking baggage exception appeared;
  - the booking or the trip is no longer valid.

  An old QR can never get around a new blocker.

- **Revalidated:** a check-in whose facts changed but still passes every gate (for example compliance re-evaluated to a current PASS) is revalidated and boarded. The boarding records the new fingerprint and `factsChangedSinceCheckIn`. A check-in can be recorded only once, so blocking it forever would leave the passenger stranded with no recovery.
- **Seat:** the seat cannot change after check-in.

## Boarding credential and QR

- **Credential:** a check-in carries one credential `ETQ-` + 16 CSPRNG characters (unique and immutable). It is never the SQL UUID.
- **QR content:** the QR encodes `ETPAX1:<credential>` and nothing else: no name, booking, trip, seat or e-mail. The SVG is rendered locally by `uqr@0.1.3` (the PR-13 dependency) and shown as an `<img>`.
- **Availability:** the QR exists only after a successful check-in.
- **A QR is an identifier, never an authorization.** A scan goes through authentication, RBAC, version parsing, lookup, a check-in lock, a replay check, the double-boarding check, re-derivation of every gate, the transaction and the audit. There is no public route.

## Boarding

`POST /v1/admin/boarding/scan` (`boarding.scan`) takes `{ qrPayload, deviceId, clientEventId?, occurredAt? }`.

| Situation                                               | Result                                                    |
| ------------------------------------------------------- | --------------------------------------------------------- |
| First valid scan                                        | `201 { created: true, boarding }`                         |
| Same `deviceId` + `clientEventId`, same payload (retry) | `201 { created: false, boarding }`: the original boarding |
| Same `deviceId` + `clientEventId`, different payload    | `409 BOARDING_CLIENT_EVENT_ID_REUSED`                     |
| Another scan of a boarded passenger                     | `409 PASSENGER_ALREADY_BOARDED`                           |
| Gates now blocked                                       | `409 CHECK_IN_STALE` with `details.blockers` (audited)    |
| Unsupported or malformed payload                        | `422 BOARDING_QR_INVALID`                                 |
| Unknown credential                                      | `404 BOARDING_CREDENTIAL_NOT_FOUND`                       |

- **One boarding:** `UNIQUE (check_in_id)` makes a second boarding of the same booking passenger impossible. The check-in row lock serializes scans.
- **Device id:** `deviceId` (1–64 characters, `[A-Za-z0-9][A-Za-z0-9._:-]*`) is bounded operational metadata, not an identity proof. Device enrollment belongs to PR-18.
- **Operator time:** `occurredAt` must lie between 5 minutes before the check-in (clock skew) or 30 days ago, whichever is later, and 5 minutes from now. `boarded_at` is the server clock.
- **Who boards:** only ACTIVE STAFF board (trigger). There is no customer boarding route.
- **Resolve first:** `POST /v1/admin/boarding/resolve` (`boarding.read`) shows passenger, seat, trip, check-in and current gates before boarding, and the read is audited.

## Concurrency

These are proven by forced-overlap tests on real PostgreSQL: requests queue behind a held row lock (`pg_stat_activity`) before it is released.

- **Two check-ins at once:** one check-in, the other request gets `created: false`.
- **The same seat for two passengers:** one assignment and one `409 SEAT_ALREADY_ASSIGNED`.
- **Eight scans of one QR at once** (same `clientEventId` and different devices), then a free burst of 30: one boarding row and one `PASSENGER_BOARDED` audit event. The others are replays or `409`s.
- **Direct-SQL writers:** they are serialized by the triggers' row locks and the unique keys.

## Audit

The audit actions are:

- `PASSENGER_SEAT_ASSIGNED` and `PASSENGER_CHECKED_IN`;
- `PASSENGER_CHECKIN_READINESS_ACCESSED` (STAFF `LIST` page, `DETAIL` and `QR_LABEL`);
- `PASSENGER_BOARDING_ACCESSED` (`RESOLVE`), `PASSENGER_BOARDED` and `PASSENGER_BOARDING_REFUSED`.

Mutations are audited in their own transaction, so an audit failure rolls the check-in or boarding back (tested). Events carry references, the seat label, codes and the device id. They never carry names, documents, the SVG or compliance facts.

## Interfaces

- **Client (`/compte`, « Check-in »):**
  - before check-in: the six gates (« OK », « À régulariser », « À vérifier »), the next useful action per blocker, the PR-12 customer guidance, the assignment of a booked seat, and « Effectuer le check-in » (enabled only when eligible);
  - after check-in: « Enregistrement effectué », the reference, seat, trip, traveller and the QR, with « Le QR ne remplace pas les documents de voyage. ».
- **OPS (« Check-in / Embarquement », `checkin.read`):**
  - a list paginated on the server and filtered by trip, booking, passenger, check-in state and boarding state;
  - a detail with gates and blockers, seat assignment and check-in (`checkin.manage`), and the QR label;
  - a boarding panel (`boarding.read`, action with `boarding.scan`) with manual QR entry, used for tests and accessibility.

## Migration

`20261014190000_check_in_boarding` is migration 14 and is additive:

- 3 tables and a unique `(id, booking_id)` index on `booking_seat` (target of the composite key);
- CHECKs, 4 functions, 6 triggers;
- 4 permissions and 19 grants.

There is no backfill: historical PR-13 booking passengers start with 0 seat assignments, 0 check-ins and 0 boardings. The upgrade test proves identical rows and then a full seat → check-in → QR → boarding flow on the historical data.

## Known limitations

- There is no check-in window (for example "opens 2 h before departure"), because none is defined. Only booking, trip, payment, documents, compliance, seat and baggage gate the check-in.
- There is no un-check-in or re-check-in workflow. A stale check-in is revalidated at boarding once its gates pass again.
- Seat swaps between two travellers of the same booking need a temporary free seat: there is no atomic swap.
- `deviceId` is not authenticated, and CREW/DRIVER cannot board yet. Both come with PR-18.
