# ADR-001 — Modular monolith

## Status

Accepted — 2026-10-12 (PR-01 Foundation)

## Context

EURO TERANGA starts with one product (COACH) and a small team, but its domains
(bookings, payments, compliance, operations, finance) are tightly coupled by
transactions: a seat allocation, a payment and a booking confirmation must stay
consistent. The platform must remain operable on modest infrastructure.

## Decision

The backend is a single deployable NestJS application (`apps/api`) organised in
modules with explicit boundaries. Modules communicate through their public
services, never by reaching into another module's tables. One PostgreSQL
database is the system of record. The API is the single business authority:
frontends never access the database.

PR-01 only contains technical modules: `AppModule`, `ConfigModule`,
`DatabaseModule` and `HealthModule`.

## Consequences

- Business invariants can rely on local ACID transactions.
- One build, one deployment, one set of logs to operate.
- Module boundaries must be enforced by review (and later lint rules), since the
  runtime does not enforce them.
- Extracting a module into a service later requires its boundary to have been
  respected.

## Alternatives considered

- **Microservices from day one** — distributed transactions, network failure
  modes and operational overhead with no proven scaling need.
- **Frontends talking to the database (BaaS style)** — no single place to
  enforce authorization, validation and audit.
