# Dependency audit

CI runs `pnpm audit:dependencies` in the `security` job. It fails on any
**high** or **critical** advisory, except the exceptions listed below. Each
exception names one advisory (never "all unfixable") and must be re-evaluated
whenever the dependency is upgraded.

## Overrides (fixed by forcing a patched version)

Declared in `pnpm-workspace.yaml` → `overrides`.

| Package        | From   | To     | Advisories                                                 | Reached through                     |
| -------------- | ------ | ------ | ---------------------------------------------------------- | ----------------------------------- |
| `mysql2`       | 3.15.3 | 3.24.5 | GHSA-3f6p-5ww8-9rcr (high), GHSA-rgwj-5xj2-c3m3 (moderate) | Prisma CLI (dev only; MySQL unused) |
| `deepmerge-ts` | 7.1.5  | 8.0.2  | GHSA-ggr8-5vv4-36mx (high)                                 | Prisma CLI → `@prisma/config`       |

Verified after override: `prisma generate`, `validate`, `migrate deploy`,
`migrate status`, `db execute` and the API integration tests.
Remove each override once Prisma ships the patched version itself.

## Accepted exceptions (no fix available)

Declared in `pnpm-workspace.yaml` → `auditConfig.ignoreGhsas`, so local
`pnpm audit` and CI apply exactly the same list.

| Advisory                                                                 | Package        | Severity | Reached through                                         | Why it is not exploitable here                                                                                                                                               | Review                                               |
| ------------------------------------------------------------------------ | -------------- | -------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces` 3.0.3 | high     | `@next/eslint-plugin-next` → `fast-glob` → `micromatch` | Lint-time only (devDependency, never shipped). Glob patterns come from the repository's own ESLint configuration, not from untrusted input. No patched version is published. | Re-check on every `@next/eslint-plugin-next` upgrade |
