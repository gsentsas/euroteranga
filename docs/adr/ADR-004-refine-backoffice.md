# ADR-004 — Refine Community for the back-office

## Status

Accepted — 2026-10-12 (PR-01 Foundation)

## Context

The operations back-office (`ops.euroteranga.com`) needs many list, filter,
form and detail screens. Building them from scratch is slow; adopting a SaaS
admin product would create a paid, external dependency for core operations.

## Decision

- `apps/ops` is a Next.js application using **Refine Community**
  (`@refinedev/core` 5, MIT) with `@refinedev/nextjs-router` (App Router).
- Refine is a **UI framework only**: navigation now; tables, filters, forms and
  data providers later. It never holds business authority — future data
  providers call the Core API, never the database.
- No Refine SaaS or paid feature is used. **Telemetry is disabled**
  (`disableTelemetry: true`).
- PR-01 delivers a layout, a navigation built from the Refine resource registry
  and a home page. No data provider, no authentication, no business dashboard.

## Consequences

- `apps/ops/tsconfig.json` enables `skipLibCheck` (exception to the repository
  default): the published declarations of `@refinedev/core` 5.0.12 reference an
  unresolved internal alias and optional type packages. Our own code remains
  strictly type-checked.
- The Refine provider is wrapped in a Suspense boundary, required by the
  Next.js router integration for static prerendering.

## Alternatives considered

- **React Admin** — comparable; Refine's headless approach fits a shared UI
  package better.
- **SaaS admin builders** — paid, external dependency on core operations.
- **Plain Next.js without an admin framework** — more code to write and
  maintain for every list and form.
