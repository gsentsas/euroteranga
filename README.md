# EURO TERANGA

> **Status: Foundation implemented — product features not yet implemented.**
>
> The repository contains the technical foundation (monorepo, applications
> skeletons, Core API with health checks, database tooling, tests and CI). No
> booking, payment, passenger or operations feature exists yet, and nothing is
> deployed.

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

| Path                | Package                      | What it is today                        | Local port |
| ------------------- | ---------------------------- | --------------------------------------- | ---------- |
| `apps/web`          | `@euroteranga/web`           | Next.js public site skeleton            | 3000       |
| `apps/booking`      | `@euroteranga/booking`       | Next.js booking skeleton (no booking)   | 3001       |
| `apps/client`       | `@euroteranga/client`        | Next.js customer portal skeleton        | 3002       |
| `apps/tracking`     | `@euroteranga/tracking`      | Next.js tracking skeleton (no tracking) | 3003       |
| `apps/ops`          | `@euroteranga/ops`           | Next.js + Refine back-office skeleton   | 3004       |
| `apps/crew`         | `@euroteranga/crew`          | Next.js crew app skeleton (not offline) | 3005       |
| `apps/api`          | `@euroteranga/api`           | NestJS Core API — health checks only    | 4000       |
| `packages/config`   | `@euroteranga/config`        | Validated environment configuration     | —          |
| `packages/logger`   | `@euroteranga/logger`        | Structured JSON logs with redaction     | —          |
| `packages/database` | `@euroteranga/database`      | Prisma schema, migrations, client       | —          |
| `packages/ui`       | `@euroteranga/ui`            | Brand mark, page shell, design tokens   | —          |
| `tests/browser`     | `@euroteranga/browser-tests` | Playwright foundation tests             | —          |

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
| `pnpm test:e2e`                | Browser tests (Playwright) — requires built frontends |
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

| Job        | Proves                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| `quality`  | Frozen-lockfile install, lint, format, typecheck                          |
| `database` | Prisma validate, migration deploy (twice), status, `SELECT 1`             |
| `test`     | Unit and integration tests against an ephemeral PostgreSQL                |
| `build`    | All seven applications build                                              |
| `browser`  | Playwright tests on the six frontends                                     |
| `security` | Forbidden files and bypass markers, gitleaks (full history), `pnpm audit` |

Dependabot proposes grouped weekly updates (npm, GitHub Actions) and monthly
Docker updates.

## Contributing

`main` is protected: every change goes through a branch and a pull request.
See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

This repository is **public**. Never commit secrets, credentials, `.env` files,
database dumps or personal data. Report vulnerabilities privately as described
in [`SECURITY.md`](SECURITY.md).

## License

Proprietary. All rights reserved. See [`LICENSE`](LICENSE).
