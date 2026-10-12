# ADR-003 — NestJS Core API

## Status

Accepted — 2026-10-12 (PR-01 Foundation)

## Context

The Core API must host many business modules with consistent cross-cutting
concerns: configuration, logging, request correlation, error handling,
validation, authorization (later) and OpenAPI documentation.

## Decision

- **NestJS 12** on Express, written in TypeScript (strict). NestJS 12 is
  ESM-only, so the API and shared packages are ES modules.
- **REST** with **OpenAPI** generated from controller metadata. The interactive
  documentation is mounted at `/docs` only when `OPENAPI_ENABLED=true`; its
  production exposure is not decided.
- **URI versioning**: business endpoints will live under `/v1/...`. Health
  probes are version neutral: `/health`, `/health/live`, `/health/ready`.
- Foundation conventions implemented in PR-01:
  - environment validated once at startup (`@euroteranga/config`); invalid
    configuration stops the process immediately with the variable names;
  - structured JSON logs with redaction (`@euroteranga/logger`);
  - `X-Request-Id` accepted when well-formed, generated otherwise, returned in
    the response and attached to every log line;
  - one error shape `{ code, message, requestId }` with fixed public messages,
    never a stack trace or driver message;
  - CORS restricted to an explicit origin list, credentials disabled;
  - Helmet security headers; the API binds to `127.0.0.1` by default;
  - graceful shutdown on SIGTERM/SIGINT releases database connections.
- Tests use Vitest with SWC (decorator metadata). Integration tests run against
  a real PostgreSQL database.
- The Nest CLI is not used: `tsc` builds the API and a small script provides
  watch mode, which avoids a second TypeScript toolchain.

## Consequences

- Consistent module structure and dependency injection for future PRs.
- Constructor parameters of injectable classes must use concrete classes or
  explicit `@Inject` tokens (design-time metadata).

## Alternatives considered

- **Fastify or Express without a framework** — lighter, but every convention
  (DI, modules, OpenAPI, guards) would be custom code.
- **GraphQL** — not needed; REST plus OpenAPI fits the clients.
- **tRPC** — couples clients to TypeScript and the API's internal types.
