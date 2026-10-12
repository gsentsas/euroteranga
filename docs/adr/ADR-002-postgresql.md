# ADR-002 — PostgreSQL, Prisma and the baseline migration

## Status

Accepted — 2026-10-12 (PR-01 Foundation)

## Context

Critical invariants (no double seat allocation, idempotent payments) must be
enforced by the database itself. Migrations must be versioned and reproducible
from the first PR, without inventing a product model ahead of the PRs that own
each domain.

## Decision

- **PostgreSQL** is the only database. It is never exposed to the Internet.
- **Prisma 7** (`packages/database`) is the access layer and migration tool,
  using the driver-adapter client (`@prisma/adapter-pg`). The client is generated
  at build time and never committed.
- Invariants Prisma cannot express are written as explicit SQL in migrations.
- **Baseline migration**: `20261012000000_foundation_baseline` contains only
  `SELECT 1;`. It creates no table. Its purpose is to prove the pipeline end to
  end — create, deploy, idempotent re-deploy, status, recorded in
  `_prisma_migrations` — in CI against a real PostgreSQL service.
- Dev and CI use **PostgreSQL 16.15** (pinned image digest). The production
  version is decided together with the deployment model (ADR-010); the target
  host already runs a PostgreSQL 16 cluster.
- `prisma.config.ts` only declares the datasource when `DATABASE_URL` is set, so
  client generation and schema validation work in build-only contexts while
  `migrate` commands fail explicitly without it.

## Consequences

- Readiness uses `SELECT 1` through the same Prisma client as the application;
  there is no second PostgreSQL client.
- Every future schema change ships as a reviewed migration (forward, backward,
  lock risk, data risk).
- Prisma 8 is in release candidate; upgrading is a deliberate, separate change.

## Alternatives considered

- **MySQL/MariaDB** (readily available in Plesk) — weaker support for the
  constraints we need (exclusion constraints, partial unique indexes, rich
  transactional DDL).
- **A dummy business table to justify a first migration** — would create a model
  no PR owns.
- **Raw SQL migrations without an ORM** — possible, but loses typed queries;
  Prisma still allows raw SQL where needed.
