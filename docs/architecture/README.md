# EURO TERANGA — Target Architecture

> These are target architectural decisions.
> Implementation starts in PR-01 Foundation.
>
> PR-01 implements the technical foundation only (see below). No business
> feature is implemented yet. Pinned toolchain versions are recorded in
> `package.json`, `.node-version` and the catalog in `pnpm-workspace.yaml`.

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

| Area           | Decision                             |
| -------------- | ------------------------------------ |
| Style          | Modular Monolith                     |
| Frontend       | Next.js / React / TypeScript         |
| Back-office    | Refine Community                     |
| Backend        | NestJS / TypeScript / REST / OpenAPI |
| Database       | PostgreSQL                           |
| Files          | S3-compatible object storage         |
| Infrastructure | Plesk target environment             |

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

## Foundation (PR-01)

```
apps/
  web, booking, client, tracking, crew   Next.js (App Router) skeletons
  ops                                    Next.js + Refine Community skeleton
  api                                    NestJS Core API: config, database, health
packages/
  config     Zod-validated environment (API and NEXT_PUBLIC_*), Next.js defaults
  logger     Structured JSON logger with redaction
  database   Prisma 7 schema (no models yet), migrations, client factory
  ui         Text brand mark, foundation page shell, design tokens
tests/browser   Playwright tests for the six frontends
infrastructure/dev   PostgreSQL for local development only
```

Request path in the API:

```
request → X-Request-Id (accepted or generated) → Helmet headers → CORS allow-list
        → controller → service → Prisma (PostgreSQL)
errors  → { code, message, requestId } (fixed public messages, details only in redacted logs)
```

## Identity & authentication (PR-02)

`apps/api/src/auth` (AuthModule): realms CUSTOMER / STAFF / CREW, Argon2id
passwords, opaque sessions in host-only HttpOnly cookies (only SHA-256 stored),
session-bound CSRF tokens, staff TOTP with recovery codes, PostgreSQL-backed
rate limits, security event logging. Frontends use `@euroteranga/auth-client`
and never store authentication secrets in the browser.
See [`docs/security/authentication.md`](../security/authentication.md).

## Authorization, RBAC & audit (PR-03)

`apps/api/src/authorization` (AuthorizationModule): permissions and roles
seeded in PostgreSQL (single source of truth), a deny-by-default
`AuthorizationGuard` evaluated from the database on every request,
anti-escalation and last-privileged-admin rules serialized by an advisory
lock, an append-only audit trail written in the same transaction as each
privileged change, STAFF provisioning by invitation with a one-time MFA
enrollment grant, and a CLI-only SUPER_ADMIN bootstrap. The OPS app shows
`/admin/utilisateurs`, `/admin/roles` and `/admin/audit` according to
`GET /v1/admin/access/me`, but the API remains the authority.
See [`docs/security/authorization.md`](../security/authorization.md).

Health probes: `/health` (basic), `/health/live` (process alive),
`/health/ready` (PostgreSQL answers `SELECT 1` within 2 s, otherwise 503).

## Decisions

Recorded in [`docs/adr/`](../adr/README.md): modular monolith (ADR-001),
PostgreSQL and Prisma (ADR-002), NestJS (ADR-003), Refine (ADR-004), Plesk
deployment target — not yet decided (ADR-010), monorepo tooling (ADR-011),
authentication (ADR-012 to ADR-016) and authorization (ADR-017 to ADR-020).

Still open: object storage provider, offline crew
synchronisation, payment provider abstraction, regulatory rule versioning, and
the production deployment model.
