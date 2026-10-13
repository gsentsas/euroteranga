# ADR-025 — Versioned fare tables and historical trip pricing

## Status

Accepted — 2026-10-13 (PR-08 Pricing)

## Context

Booking will sell journeys between two stops of a trip. The price a
passenger pays must not change after sale, and must be explainable later:
which price list, which version, which currency. Prices change over time and
differ by route. Floating-point money silently loses cents. A hard-coded
currency list would need a release for each new market, and minor units
differ (EUR has cents, XOF has none).

## Decision

- `FareTable` (stable identity, one route, one immutable currency and minor
  unit), `FareTableVersion` (numbered price list for exactly one published
  route version) and `FareEntry` (one base fare between two stops) are
  separate. Versions follow `DRAFT → PUBLISHED → RETIRED`, with at most one
  DRAFT and one PUBLISHED per fare table. Publication retires the previous
  version in the same transaction.
- **Money is an exact integer** (`amountMinor`, PostgreSQL `INTEGER`) in the
  minor unit stated on the fare table (0–3). The currency is three uppercase
  letters, without an ISO list in code. No float or double is used for money
  anywhere; clients format with a tested `BigInt`-based helper and convert
  input without rounding.
- Fares are **explicit per origin/destination pair**: stops of the version's
  route version, boarding origin, alighting destination, origin before
  destination. The matrix may be partial; a missing pair has **no** fare (no
  fallback, interpolation or per-kilometre derivation).
- Published and retired versions are immutable, enforced by PostgreSQL
  triggers for every writer. A price change requires a new version. The
  DRAFT matrix is replaced as a whole, atomically.
- A **trip** carries its **historical pricing** (`fareTableVersionId`),
  chosen explicitly while DRAFT, frozen by scheduling. A new assignment needs
  a currently published version of an active fare table pricing **exactly**
  the trip's route version. Pricing is optional for scheduling.
- Fares are **resolved on the server** from the trip's own version.
- `pricing.read` / `pricing.manage`; assigning a published version to a
  trip needs `trip.manage` + `pricing.read`, not `pricing.manage`.
- Lock hierarchy: trip → fare table → version for assignments; catalogue
  writes take fare table → version; publication never locks trips.

## Consequences

- Sold journeys will refer to an immutable price list. Booking can rely on
  `trip.fareTableVersionId` and the resolution endpoint.
- Retiring a version or deactivating a fare table never invalidates trips
  already priced; they keep resolving their historical fares.
- A route change (new route version) requires a new fare-table version: a
  price list never silently applies to a different geometry.
- Operators must enter each priced pair. This is intended: an unpriced pair
  is visible, not guessed.
- The `trip_lifecycle_guard` function is extended with `CREATE OR REPLACE`;
  PR-06 and PR-07 rules are kept verbatim and re-tested.
- Triggers are invisible to Prisma drift detection. They are covered by
  direct database tests and mutation checks.

## Alternatives considered

- **Decimal or float amounts** — floats lose precision; a decimal type
  still invites client-side arithmetic. Integer minor units are exact and
  portable.
- **Hard-coded ISO 4217 table** — couples releases to currency lists; the
  operator states currency and minor unit explicitly instead.
- **Prices on the route or the route version** — rewriting prices would
  rewrite the history of sold trips.
- **Implicit pricing from the route's current fare table** — the price of a
  scheduled trip would change when a new version is published.
- **Derived fares (per km, symmetry, sum of legs)** — hides business
  decisions and produces unexplainable prices.
- **Seat classes or per-seat supplements now** — out of scope; booking and
  later pricing work will decide if they are needed.
