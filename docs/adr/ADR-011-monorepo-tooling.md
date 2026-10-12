# ADR-011 — Monorepo tooling

## Status

Accepted — 2026-10-12 (PR-01 Foundation)

## Context

The repository hosts seven applications and four shared packages that must be
built, linted and tested consistently, locally and in CI, with reproducible
toolchain versions.

## Decision

- **pnpm 12 workspaces**, version pinned by `packageManager` and activated
  through Corepack. Node.js **24.21.0 LTS** pinned in `.node-version`
  (used by CI) and constrained by `engines`.
- **Exact versions**: direct dependencies use a shared pnpm **catalog** in
  `pnpm-workspace.yaml` (one version per dependency across the repo) and
  `saveExact`. `pnpm-lock.yaml` is committed; CI installs with
  `--frozen-lockfile`.
- **Install scripts are denied by default** (pnpm `allowBuilds`): only Prisma
  and SWC may run them; the `@scarf/scarf` telemetry script is explicitly
  denied.
- **No Turborepo** for now. Orchestration uses `pnpm --recursive`, which already
  runs workspace scripts in dependency order (packages before apps).
- Shared packages are compiled to `dist/` with `tsc` and consumed as ES modules.

### Why not Turborepo (yet)

- Build graph is small: four packages, seven apps; `pnpm -r` handles ordering.
- CI is split into parallel jobs (quality, database, test, build, browser,
  security), which gives most of the wall-clock benefit without a task cache.
- Turborepo's value is mainly its (remote) cache; remote caching would add a
  service and credentials to manage, local caching adds little in CI.
- Fewer moving parts to maintain during the foundation phase.

Revisit when build times or the number of packages make caching worthwhile.

## Consequences

- `pnpm build:packages` must run before typechecking or starting apps; root
  scripts (`dev`, `build`) do it automatically.
- Upgrades are deliberate: change the catalog version, refresh the lockfile,
  let CI prove it (Dependabot proposes grouped weekly updates with a 7-day
  cooldown).

## Alternatives considered

- **Turborepo** — see above.
- **Nx** — powerful but heavier, with its own conventions and generators.
- **npm workspaces** — no catalog, weaker strictness on undeclared dependencies.
