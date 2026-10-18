# EURO TERANGA

> **Status: Foundation through PR-25 Pilot Acceptance —\n> NOT PRODUCTION DEPLOYED.**
>
> The repository contains the technical foundation, authentication for three
> realms (customer, staff with mandatory TOTP, crew) and server-side
> authorization: roles and permissions, controlled STAFF provisioning by
> invitation, an append-only audit trail. It also contains the first
> operations domains:
>
> - network: countries, stops, checkpoints and immutable versioned routes;
> - fleet core: the vehicle registry with its lifecycle;
> - trips: planned occurrences of published route versions, with a UTC
>   timetable frozen at scheduling and an optional vehicle;
> - seat maps: versioned physical layouts with computed capacity, the
>   current seat map of a vehicle and the historical seat map of a trip;
> - pricing: versioned base fare tables between stops, in exact integer
>   minor units of an explicit currency, and the historical pricing of a
>   trip, resolved on the server.
> - booking: public journey search and segment-aware availability, authenticated
>   CUSTOMER seat holds, owned booking history/cancellation and permissioned
>   STAFF administration.
> - payments: a payment provider abstraction with payment attempts and
>   idempotent, signed provider events. A succeeded payment confirms a booking,
>   which then keeps its seats.
> - reporting: permissioned OPS KPI over trips, bookings, finance, incidents,
>   baggage and fleet, calculated server-side with strict per-currency buckets.
>
> **There is no real payment provider:** the only one, SANDBOX, simulates
> payments locally for development, tests and CI, and is refused in staging
> and production. No real money moves and no card data is ever collected. A
> The repository now also contains passenger/document compliance, baggage,
> check-in/boarding, manifests, permits, departure dispatch, Crew offline flows,
> tracking, borders, incidents, operational finance/refunds, aggregated reporting, security hardening and a\n> reproducible pilot-acceptance gate. There is still no real payment provider, statutory accounting or
> production deployment; this remains pre-production software.

EURO TERANGA is a future digital platform for operating international road
passenger transport services between Europe and Africa.

- **Website:** <https://euroteranga.com>
- **First product:** EURO TERANGA COACH
- **First corridor:** Paris ↔ Dakar — France → Spain → Morocco → Mauritania → Senegal

## Architecture

```
Web / Booking / Client / Tracking
            ↓
          Core API
            ↓
        PostgreSQL
            ↓
 OPS / Crew / Workers / Storage
```

The Core API is the single business authority: frontends never access the
database. The backend is a modular monolith. Details:
[`docs/architecture`](docs/architecture/README.md) and the decision records in
[`docs/adr`](docs/adr/README.md).

## Monorepo

| Path                   | Package                      | What it is today                                                             | Local port |
| ---------------------- | ---------------------------- | ---------------------------------------------------------------------------- | ---------- |
| `apps/web`             | `@euroteranga/web`           | Next.js public site skeleton                                                 | 3000       |
| `apps/booking`         | `@euroteranga/booking`       | Public search, historical seat selection, CUSTOMER holds and SANDBOX payment | 3001       |
| `apps/client`          | `@euroteranga/client`        | Customer auth, account, owned bookings and their payments                    | 3002       |
| `apps/tracking`        | `@euroteranga/tracking`      | Public tracking projection                                                   | 3003       |
| `apps/ops`             | `@euroteranga/ops`           | Refine back-office including operations, finance and reporting               | 3004       |
| `apps/crew`            | `@euroteranga/crew`          | Crew operations with offline event queue                                     | 3005       |
| `apps/api`             | `@euroteranga/api`           | NestJS Core API — auth, RBAC and operational domains through PR-24           | 4000       |
| `packages/config`      | `@euroteranga/config`        | Validated environment configuration                                          | —          |
| `packages/logger`      | `@euroteranga/logger`        | Structured JSON logs with redaction                                          | —          |
| `packages/database`    | `@euroteranga/database`      | Prisma schema, migrations, client                                            | —          |
| `packages/ui`          | `@euroteranga/ui`            | Brand mark, page shell, forms, tokens                                        | —          |
| `packages/auth-client` | `@euroteranga/auth-client`   | Typed browser client for Core API                                            | —          |
| `packages/content`     | `@euroteranga/content`       | Structured website content model (blocks, settings, navigation)              | —          |
| `tests/browser`        | `@euroteranga/browser-tests` | Playwright foundation, auth and business flows                               | —          |

Ports are a local development convention only; production does not depend on
them.

## Requirements

- **Node.js 24.21.0** (LTS) — see `.node-version`
- **pnpm 12.11.2** — pinned in `package.json` (`packageManager`), provided by Corepack
- **Docker** (optional) — to run the local PostgreSQL database

## Local setup

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose -f infrastructure/dev/docker-compose.yml up -d
pnpm db:migrate
pnpm dev
```

Mailpit (started by the same compose file) catches authentication mail at
<http://localhost:8025>. STAFF and CREW identities have no self-registration:
create local ones directly in the development database (see
`apps/api/test/support/auth-helpers.ts` for the fixture approach).

`pnpm dev` builds the shared packages, then starts the six frontends and the API
in watch mode. Open <http://localhost:3000> (web) to <http://localhost:3005>
(crew), and <http://localhost:4000/health> for the API. When
`OPENAPI_ENABLED=true`, the API documentation is served at
<http://localhost:4000/docs>.

## Environment

All configuration comes from environment variables, validated at startup.
`.env.example` lists every variable with **placeholder values only**; copy it to
`.env` (never committed).

| Variable                   | Used by     | Purpose                                                    |
| -------------------------- | ----------- | ---------------------------------------------------------- |
| `NODE_ENV`                 | API         | `development`, `test` or `production`                      |
| `APP_ENV`                  | API         | `local`, `ci`, `staging` or `production`                   |
| `DATABASE_URL`             | API, Prisma | PostgreSQL connection string (secret)                      |
| `API_HOST` / `API_PORT`    | API         | Bind address (default `127.0.0.1`) and port (default 4000) |
| `API_CORS_ORIGINS`         | API         | Comma-separated exact origins; `*` is rejected             |
| `OPENAPI_ENABLED`          | API         | Serve `/docs` (default `false`)                            |
| `LOG_LEVEL`                | API         | `debug`, `info`, `warn` or `error`                         |
| `NEXT_PUBLIC_APP_ENV`      | Frontends   | Environment label shown in the UI                          |
| `NEXT_PUBLIC_API_BASE_URL` | Frontends   | Core API base URL                                          |
| `NEXT_PUBLIC_CLIENT_URL`   | Booking     | Public Client app URL used for account links               |

Authentication adds `AUTH_CSRF_KEY`, `AUTH_HMAC_KEY`,
`AUTH_TOTP_ENCRYPTION_KEY` (secrets, base64), per-realm origins
(`AUTH_*_ORIGINS`) and session lifetimes, token lifetimes, `API_TRUST_PROXY`,
and mail settings (`AUTH_MAIL_PROVIDER`, `SMTP_*`, `AUTH_EMAIL_FROM`,
`CLIENT_PUBLIC_URL`). The example keys in `.env.example` are refused in
staging and production. Details: [`docs/security/authentication.md`](docs/security/authentication.md).

Payments add `PAYMENT_PROVIDER` (`DISABLED` by default; `SANDBOX` only in
local and ci) and, with SANDBOX, the server-side webhook key
`PAYMENT_SANDBOX_WEBHOOK_SECRET`: never a `NEXT_PUBLIC_` value. See
[`docs/domain/payments.md`](docs/domain/payments.md).

Authorization adds `OPS_PUBLIC_URL` (base of STAFF invitation links, HTTPS in
staging and production), `AUTH_STAFF_INVITATION_TTL_SECONDS` and
`AUTH_STAFF_ENROLLMENT_GRANT_TTL_SECONDS`. The first SUPER_ADMIN is created
with `pnpm auth:bootstrap-super-admin` (CLI only): see
[`docs/security/authorization.md`](docs/security/authorization.md) and
[`docs/runbooks/bootstrap-super-admin.md`](docs/runbooks/bootstrap-super-admin.md).

`NEXT_PUBLIC_*` values are embedded in browser code: builds fail when a
sensitive-looking variable uses this prefix.

## Commands

| Command                        | Description                                           |
| ------------------------------ | ----------------------------------------------------- |
| `pnpm dev`                     | Build packages, then run all apps in watch mode       |
| `pnpm build`                   | Build the packages and all seven applications         |
| `pnpm lint`                    | ESLint                                                |
| `pnpm format` / `format:check` | Prettier write / check                                |
| `pnpm typecheck`               | TypeScript (strict) in every workspace                |
| `pnpm test:unit`               | Unit tests (Vitest)                                   |
| `pnpm test:integration`        | API integration tests — requires `DATABASE_URL`       |
| `pnpm test:e2e`                | Browser tests (Playwright) — requires built frontends | \n  | `pnpm pilot:acceptance` | Dedicated non-destructive PR-25 pilot browser gate |
| `pnpm test`                    | Unit + integration tests                              |
| `pnpm db:validate`             | Validate the Prisma schema                            |
| `pnpm db:migrate`              | Apply migrations (`prisma migrate deploy`)            |
| `pnpm db:migrate:status`       | Show migration status                                 |
| `pnpm check:forbidden-files`   | Repository hygiene gate                               |

Browser tests locally:

```bash
pnpm build:packages && pnpm build:frontends
pnpm --filter @euroteranga/browser-tests exec playwright install chromium
pnpm test:e2e
```

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on `main`, with
read-only permissions and actions pinned to commit SHAs:

| Job        | Proves                                                                     |
| ---------- | -------------------------------------------------------------------------- |
| `quality`  | Frozen-lockfile install, lint, format, typecheck                           |
| `database` | Prisma validate, migration deploy (twice), status, `SELECT 1`              |
| `test`     | Unit and integration tests against an ephemeral PostgreSQL                 |
| `build`    | All seven applications build                                               |
| `browser`  | Playwright: six frontends + auth flows against the real API and PostgreSQL |
| `security` | Forbidden files and bypass markers, gitleaks (full history), `pnpm audit`  | \n  | `pilot-acceptance` | Aggregate success of all mandatory CI jobs |

`.github/workflows/codeql.yml` runs CodeQL (security-extended) on pull
requests, on `main` and weekly. Dependabot proposes grouped weekly updates (npm, GitHub Actions) and monthly
Docker updates. The pilot go/no-go matrix is documented in\n[`docs/pilot/acceptance.md`](docs/pilot/acceptance.md).\n\n## Contributing

`main` is protected: every change goes through a branch and a pull request.
See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

This repository is **public**. Never commit secrets, credentials, `.env` files,
database dumps or personal data. Report vulnerabilities privately as described
in [`SECURITY.md`](SECURITY.md).

## License

Proprietary. All rights reserved. See [`LICENSE`](LICENSE).
