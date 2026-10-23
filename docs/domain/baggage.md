# Baggage (PR-13 + BAGGAGE-PLUS-1)

PR-13 gives each bag a public identity, a printable QR code, an exact
STAFF-measured weight and an immutable operational history. A bag always
belongs to one **booking passenger**: one person on one confirmed booking.

**Out of scope:**

- check-in and boarding (PR-14);
- manifests (PR-15);
- permits (PR-16);
- trip readiness (PR-17);
- the offline Crew scanner (PR-18);
- incident workflows (PR-21);
- finance (PR-22).

BAGGAGE-PLUS-1 adds a **versioned allowance and excess-price catalogue**. It still creates **no payment, revenue, refund or credit**. A calculated excess amount is a commercial snapshot only.

## Model

| Table                    | Role                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `baggage`                | Identity, owning `BookingPassenger`, current operational projection and frozen commercial snapshot. |
| `baggage_event`          | Append-only operational history. Every projection change is one event.                              |
| `baggage_policy`         | Stable commercial identity (code/name/currency/active).                                             |
| `baggage_policy_version` | Historical allowance linked to a fare-table version: DRAFT → PUBLISHED → RETIRED.                   |
| `baggage_excess_tier`    | Explicit maximum excess-weight tiers and exact charges in minor units.                              |

`Baggage`:

- **Identity:** `reference` is `ETG-` followed by 12 CSPRNG Crockford base32 characters (60 bits). It is immutable and carries no passenger or journey information.
- **Owner:** `(booking_id, passenger_id)` references `booking_passenger`. The owner, the type and the reference never change.
- **Type:** `SUITCASE`, `TRAVEL_BAG`, `BOX` or `OTHER`.
- **Projection:** `lifecycle_status`, `exception_status` and `measured_weight_kg`. This is a controlled copy of the latest event, never written directly.
- **Commercial snapshot:** `baggage_policy_version_id` and `allowance_piece_ordinal` are frozen at registration. `included_weight_kg`, `excess_weight_kg`, `excess_charge_minor`, `excess_charge_currency_code` and `excess_charge_currency_minor_unit` are server-derived only when STAFF records an official weight.

`BaggageEvent`:

- **Sequence:** gapless, 1, 2, 3 and so on, unique per bag.
- **Content:**
  - the event type and the resulting projection;
  - `occurred_at`, as reported by the operator;
  - `recorded_at`, the server clock, set by the trigger;
  - the actor;
  - an optional route waypoint;
  - an optional `client_event_id`;
  - a SHA-256 `payload_fingerprint`.

## Reference and QR code

- **QR content:** the QR contains only the versioned payload `ETG1:<reference>`. It holds no name, booking, passenger, trip, weight or URL.
- **Local rendering:** the SVG is generated locally by `uqr` (no network service). Clients render it as an image (`data:image/svg+xml`) and never inject it as markup.
- **A QR is an identifier, never an authorization.** A scan goes through authentication, then RBAC, then lookup, domain validation, a transaction and an audit record.
- **Versioning:** an unsupported version (for example `ETG2:`) or a bare reference is refused with `422 BAGGAGE_QR_INVALID`.

## Exact weight

- **Storage:** weight is stored as `numeric(6,3)` in kilograms, from 0.001 to 999.999. A CHECK applies on both tables.
- **Representation:** the API reads and writes weights as **decimal strings**, for example `"12.345"`. Validation and normalization use string rules (`^(0|[1-9][0-9]{0,2})(\.[0-9]{1,3})?$`) and never `Number()` or `parseFloat()`. The API returns three decimals, and the UIs display the string with a decimal comma.
- **Authority:** only STAFF holding `baggage.manage` record the official weight (`WEIGHT_UPDATED`). A CUSTOMER registration that carries a weight is refused (`400`, strict schema).
- **Changes:** a weight event must change the weight. Recording the same value is refused.

## Franchise et excédent (BAGGAGE-PLUS-1)

The allowance is **pieces + maximum weight per included piece**, not a global
weight envelope. The master product rules are represented by policy data, not
constants in application code: for example ECO can be configured as one
23 kg piece and STANDARD as two 23 kg pieces. PLUS/FLEX may reference the
same allowance values through their own historical pricing context. Extra
baggage and overweight amounts are configured by OPS; example business prices
are never defaults in code.

A policy version is linked to the historical `FareTableVersion` used by the
booking. At baggage registration PostgreSQL and the API serialize on the
`BookingPassenger`, choose the currently PUBLISHED policy version for that
fare version (or the latest RETIRED historical version when no current version
exists), and freeze:

- the policy-version id;
- the 1-based baggage ordinal for that passenger/booking.

This is the **freeze moment**. Later policy publication never rewrites an old
bag. The unique partial ordinal index plus row locks prevent two concurrent
registrations from receiving the same place.

Only a STAFF `WEIGHT_UPDATED` event can compute the commercial snapshot:

1. included weight = the policy per-piece weight when
   `allowance_piece_ordinal <= included_pieces`, otherwise 0;
2. excess = `max(measured - included, 0)`, with exact three-decimal string
   arithmetic;
3. zero excess produces exact charge 0 in the policy currency;
4. positive excess selects the **smallest configured tier whose
   `max_excess_weight_kg` covers the excess**;
5. if no tier covers it, the excess stays known but the charge is `NULL`
   (UI: **tarif à confirmer**).

PostgreSQL recomputes and verifies these values in `baggage_guard`, so direct
SQL cannot invent a lower charge, a different allowance, or a different
currency. Published/retired versions and their tiers are historical and
immutable.

There is deliberately **no Payment, PaymentQuote or TripRevenue creation** in
this workflow. A displayed amount is not proof of payment and cannot unlock a
payment/check-in gate.

## Lifecycle and exceptions

Normal lifecycle, strictly linear:

```
REGISTERED → CHECKED_IN → LOADED → IN_TRANSIT → ARRIVED → DELIVERED
```

Exceptions are separate from the lifecycle:

- **Opening:** `MISSING`, `DAMAGED` and `HELD_BY_CUSTOMS` open an exception. Only one can be active at a time.
- **Effect:** an active exception blocks normal progression.
- **Resolution:** `EXCEPTION_RESOLVED` clears it, and the lifecycle resumes where it was.

Other rules:

- **`REMOVED`:** allowed from any status except `DELIVERED`, and **terminal**. After it no event of any kind is accepted. A removed bag is history: it is never physically deleted (`DELETE` is refused by trigger).
- **`REGISTERED`:** only valid as the first event (sequence 1). Registration creates the bag and this event atomically.
- **`WEIGHT_UPDATED`:** changes only the weight.

The API checks every transition with a pure function (`projectBaggageEvent`). PostgreSQL enforces the same matrix in `baggage_event_guard`, so a direct SQL write cannot bypass it.

## Projection and history

- `baggage_event` refuses `UPDATE`, `DELETE` and `TRUNCATE`.
- `baggage` refuses `DELETE` and `TRUNCATE`.
- A projection change without a matching latest event is refused (`baggage_guard`).
- A deferred constraint trigger on both tables checks at commit that:
  - every bag has its initial `REGISTERED` event;
  - the projection equals its latest event.

  An event without a projection update, or a projection without an event, therefore cannot commit.

- One event must be projected before the next is appended. This closes the "batch insert of several events" gap.

## Idempotency

- `client_event_id` (8–64 characters) is optional and unique **per bag**. When it is set, `occurredAt` is mandatory.
- **Same id, same payload** (type, `occurredAt`, waypoint, weight, compared by fingerprint): the original event comes back with `created: false`. This also holds when later events were recorded in between.
- **Same id, different payload:** `409 BAGGAGE_CLIENT_EVENT_ID_REUSED`.

## Concurrency

- **API:** every event transaction first takes `SELECT … FOR UPDATE` on the bag row. It then checks the replay, computes the transition and the next sequence, inserts the event, updates the projection and writes the audit record.
- **Database:** the event trigger locks the same row (`FOR UPDATE OF bg`) and requires `sequence = previous + 1`.
- **Proof:** forced-overlap tests on real PostgreSQL hold the row lock, wait for two HTTP requests to queue behind it (`pg_stat_activity`), then release it. They check that:
  - a duplicate transition gives exactly 201 and 409;
  - incompatible transitions give exactly 201 and 409;
  - simultaneous retries with the same `client_event_id` give one event (`created: true` and `created: false`);
  - no sequence is duplicated, no event is lost and no projection mismatches.

## Eligibility

A bag can be registered only on a `BookingPassenger` whose booking is confirmed and not cancelled, on a `SCHEDULED` trip. The booking customer must also be the passenger owner. PostgreSQL checks this under a share lock on the booking and pair.

- **CUSTOMER:** registers for their own pair only. Foreign and unknown pairs get the same 404.
- **STAFF:** registers with `baggage.manage`.

Later operational events need ACTIVE STAFF. An event's `occurred_at` must be no earlier than both the booking creation and 30 days ago, and no later than 5 minutes from now.

## API

Customer realm, under `/v1/booking`, own resources only:

| Method | Path                                                                 | Notes                                         |
| ------ | -------------------------------------------------------------------- | --------------------------------------------- |
| POST   | `/bookings/:bookingReference/passengers/:passengerReference/baggage` | CSRF; body `{ type }` only; 30/h per identity |
| GET    | `/bookings/:bookingReference/baggage`                                | bags of an owned booking                      |
| GET    | `/baggage/:reference`                                                | detail and public timeline                    |
| GET    | `/baggage/:reference/qr`                                             | `{ reference, svg }`                          |

STAFF routes are under `/v1/admin/baggage`; see
[authorization.md](../security/authorization.md#admin-api). Views carry
references, never internal UUIDs, actors, `client_event_id` or fingerprints.

## Interfaces

- **Client (`/compte`, « Mes bagages »):** registration on an owned confirmed booking's traveller, reference, type, status, measured weight, QR and timeline, plus the historical allowance, piece ordinal, exact excess and charge when a configured tier covers it. No payment action is exposed.
- **OPS (« Bagages », `baggage.read`):**
  - bounded list with server-side filters (reference, booking, trip, type, status, exception);
  - authenticated QR lookup;
  - detail with passenger, booking, trip, weight, frozen allowance, excess/charge result, QR label and immutable timeline;
  - with `baggage.manage`, weight and event forms. There is no status or commercial-amount field to edit.
- **OPS → Tarification (`pricing.read`):** baggage-policy catalogue and history. `pricing.manage` creates/updates the catalogue, DRAFT versions and tiers, then publishes.

## Migrations

`20261014150000_baggage` introduced the PR-13 operational model.

`20261023020000_baggage_plus_1` is additive: policy/version/tier tables, frozen policy/ordinal columns, exact currency-minor-unit snapshot, historical guards and commercial verification in `baggage_guard`.

The original migration is additive:

- 4 enums and 2 tables, with indexes, FKs and CHECKs;
- 3 guard functions plus 1 no-truncate function, 4 triggers and 2 deferred constraint triggers;
- 2 permissions and 11 grants.

There is no backfill. The PR-12 → PR-13 upgrade test proves that every populated PR-09…PR-12 row stays identical and that a historical `BookingPassenger` can register a bag afterwards.

## Known limitations

- The current Pricing domain has one historical fare-table version per booking journey and no simultaneous ECO/STANDARD/PLUS/FLEX fare-class selection inside one trip. BAGGAGE-PLUS therefore attaches one published baggage policy to a fare-table version at a time; richer multi-class fares require a future Pricing evolution.
- Registration does not depend on the trip's departure time. Only the trip status (`SCHEDULED`) and the booking state are checked.
- The customer list returns at most 100 bags per booking.
- `client_event_id` is scoped per bag. A device that reuses an id on another bag records a new event there.
- Excess amounts are informational commercial snapshots until a later explicit payment workflow is approved. Physical printers and richer special-baggage products remain future work.
