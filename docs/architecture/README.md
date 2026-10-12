# EURO TERANGA — Target Architecture

> These are target architectural decisions.
> Implementation starts in PR-01 Foundation.
>
> Nothing described in this document is implemented yet. Exact versions of
> runtimes, frameworks and tools are intentionally not specified: they will be
> selected and pinned during PR-01 after verifying current stable releases,
> mutual compatibility and compatibility with the target environment.

## Vision

EURO TERANGA operates international road passenger transport between Europe
and Africa. The first product, **EURO TERANGA COACH**, serves the Paris ↔ Dakar
corridor (France → Spain → Morocco → Mauritania → Senegal).

The core primitives (country, city, stop, route, trip, passenger, vehicle) are
designed to remain generic so that future domains (cargo, travel, mobility) can
reuse them. Routes, regulatory rules and corridors are data, never hard-coded.

## Overview

```
Web / Booking / Client / Tracking
            ↓
          Core API
            ↓
        PostgreSQL
            ↓
 OPS / Crew / Workers / Storage
```

## Validated target decisions

| Area           | Decision                                        |
| -------------- | ----------------------------------------------- |
| Style          | Modular Monolith                                |
| Frontend       | Next.js / React / TypeScript                    |
| Back-office    | Refine Community                                |
| Backend        | NestJS / TypeScript / REST / OpenAPI            |
| Database       | PostgreSQL                                      |
| Files          | S3-compatible object storage                    |
| Infrastructure | Plesk target environment                        |

## Core principles

- **Single business authority: the API.** Frontends never access the database
  directly. Every request goes through authentication, authorization,
  validation, domain services and transactions, with auditing of sensitive
  actions.
- **Database-enforced invariants.** Critical rules (for example, a seat cannot
  be allocated twice) are guaranteed by PostgreSQL constraints, not only by
  application code.
- **Server-side computation.** Prices, readiness and compliance are computed by
  the server; the browser never decides them.
- **Private by default.** Sensitive files live in private object storage, never
  in a public web root.
- **No microservices at launch.** Modules are separated inside one deployable
  backend; extraction is considered only when a proven need exists.

## Decisions still open

To be documented as Architecture Decision Records (`docs/adr/`) during PR-01
and later:

- deployment model on Plesk (Passenger, systemd services or Docker Compose);
- monorepo tooling;
- ORM and migration strategy;
- object storage provider;
- authentication and session architecture;
- offline crew synchronisation;
- payment provider abstraction;
- regulatory rule versioning.
