# Dependency audit

CI runs `pnpm audit:dependencies` in the `security` job. It fails on any
**high** or **critical** advisory, except the exceptions listed below. Each
exception names one advisory (never "all unfixable") and must be re-evaluated
whenever the dependency is upgraded.

## PR-11 additions

All direct versions remain exact catalog pins (`pnpm-workspace.yaml`). The
repository defines no minimum-release-age setting. Registry publish dates,
checked on 2026-10-14: `@aws-sdk/client-s3` 3.1146.0 on 2026-10-02,
`busboy` 1.6.0 on 2022-04-19, `@types/busboy` 1.5.4 on 2024-05-02. The AWS
SDK is released very frequently; PR-11 keeps the pinned version rather than
chasing newer releases, and future upgrades go through the usual
Dependabot/audit review.

`pnpm audit:dependencies` (high and critical) reports no advisory for these
packages or their transitive trees; the only reported finding remains the
pre-existing, reviewed exception below.

| Package                       | Purpose                                             | License    | Maintenance/security                                                                                                           | Alternatives and runtime impact                                                                                                                                  |
| ----------------------------- | --------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@aws-sdk/client-s3` 3.1146.0 | Private S3-compatible `put/get/head/delete` adapter | Apache-2.0 | Official modular AWS SDK, actively maintained; covered by `pnpm audit` and contract tests                                      | Raw SigV4 or a vendor SDK would add bespoke security/vendor coupling. This is the only new material runtime tree and loads only in the API; no SaaS is required. |
| `busboy` 1.6.0                | Bounded streaming multipart parser                  | MIT        | Mature, small parser used directly so upload limits/part counts stay explicit; covered by hostile-shape tests and `pnpm audit` | Buffering middleware was rejected because document bodies must stream and global body parsing would broaden attack surface. Runtime dependency, no native build. |
| `@types/busboy` 1.5.4         | Compile-time declarations for Busboy                | MIT        | DefinitelyTyped release; typecheck only, absent from production runtime                                                        | Local handwritten declarations would drift from the parser API. Dev-only, zero runtime impact.                                                                   |

MinIO and a ClamAV npm wrapper were not added. The S3 adapter is tested at its
command boundary, and the ClamAV adapter implements the small clamd `INSTREAM`
protocol with Node's built-in TCP streams. This avoids extra runtime packages,
containers and a mandatory external service in deterministic CI.

## MEDIA-1 additions

| Package        | Purpose                                                                              | License                                                                       | Maintenance/security                                                                                                                                                        | Alternatives and runtime impact                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharp` 0.35.5 | Decoding of uploaded website images and WebP re-encoding without metadata (API only) | Apache-2.0; prebuilt libvips (`@img/sharp-libvips-*` 1.3.4) LGPL-3.0-or-later | Most used Node image library, actively maintained, published 2026-09-27. Prebuilt binaries for the pilot platform (linux-x64), no compiler needed. Covered by `pnpm audit`. | Pure-JS decoders cannot safely re-encode every JPEG/PNG/WebP with orientation, nor bound pixels before decoding. Native code loads only in the API process. Exposure is reduced by the format allow-list checked before decoding, the pixel limit and failing on decoder errors (`docs/security/media.md`). |

`sharp` is a catalog pin (`pnpm-workspace.yaml`) used only by `apps/api`. Its
platform packages are optional dependencies: only the one matching the
installing machine is downloaded.

## Overrides (fixed by forcing a patched version)

Declared in `pnpm-workspace.yaml` → `overrides`.

| Package        | From   | To     | Advisories                                                 | Reached through                                 |
| -------------- | ------ | ------ | ---------------------------------------------------------- | ----------------------------------------------- |
| `body-parser`  | 2.3.0  | 2.4.0  | GHSA-27r3-jxmh-p828 (high)                                 | NestJS platform-express → Express (runtime API) |
| `mysql2`       | 3.15.3 | 3.24.5 | GHSA-3f6p-5ww8-9rcr (high), GHSA-rgwj-5xj2-c3m3 (moderate) | Prisma CLI (dev only; MySQL unused)             |
| `deepmerge-ts` | 7.1.5  | 8.0.2  | GHSA-ggr8-5vv4-36mx (high)                                 | Prisma CLI → `@prisma/config`                   |

Verified after override: `prisma generate`, `validate`, `migrate deploy`,
`migrate status`, `db execute` and the API integration tests.
The `body-parser` override is runtime-facing and should be removed once Express/NestJS resolves to 2.4.0 or newer naturally. Remove each Prisma-tooling override once Prisma ships the patched version itself.

## Accepted exceptions (no fix available)

Declared in `pnpm-workspace.yaml` → `auditConfig.ignoreGhsas`, so local
`pnpm audit` and CI apply exactly the same list.

| Advisory                                                                 | Package        | Severity | Reached through                                         | Why it is not exploitable here                                                                                                                                               | Review                                               |
| ------------------------------------------------------------------------ | -------------- | -------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces` 3.0.3 | high     | `@next/eslint-plugin-next` → `fast-glob` → `micromatch` | Lint-time only (devDependency, never shipped). Glob patterns come from the repository's own ESLint configuration, not from untrusted input. No patched version is published. | Re-check on every `@next/eslint-plugin-next` upgrade |
