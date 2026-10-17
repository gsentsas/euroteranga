# Pilot acceptance (PR-25)

## Purpose

PR-25 closes the implementation roadmap with a reproducible pilot-acceptance gate.
It does not declare EURO TERANGA production-ready by itself and it does not choose
the deployment model left open by ADR-010.

The pilot may be accepted only when the exact candidate commit is identified,
all mandatory CI/security gates are green, the dedicated browser acceptance
scenario passes, the operational checklist has owners/evidence, and no blocker
is waived silently.

## Automated go/no-go gates

| Gate     | Mandatory evidence                                            |
| -------- | ------------------------------------------------------------- |
| quality  | lint, format, typecheck                                       |
| database | Prisma validate, deploy twice, migration status, connectivity |
| test     | unit tests and real PostgreSQL integration                    |
| build    | production build of all seven applications                    |
| browser  | full Playwright suite including pilot-acceptance.spec.ts      |
| security | forbidden-file checks, Gitleaks, dependency audit             |
| CodeQL   | successful CodeQL workflow                                    |
| review   | no unresolved blocking review/thread                          |

The CI workflow exposes an aggregate `pilot-acceptance` job that succeeds only
when the six CI jobs above succeed. CodeQL remains a separate mandatory workflow.

## Dedicated pilot browser scenario

Run only against a disposable local/CI database:

```bash
pnpm build
pnpm db:migrate
pnpm pilot:acceptance
```

The scenario is non-destructive. It proves:

- Core API readiness returns the minimal `{"status":"ok"}` contract with a request id;
- all six frontends answer and expose the shared CSP baseline;
- a seeded bookable trip is discoverable without reserving inventory;
- an authenticated customer can see the seeded confirmed booking;
- an authorized OPS user can open Dispatch and Reporting;
- an authenticated Crew user can open the assigned synthetic trip;
- no page-level JavaScript error occurs on those critical paths.

It never calls a real payment provider and never uses real passenger data.

## Candidate identity

Record for every candidate:

- Git commit SHA;
- PR number;
- CI run number;
- CodeQL run number;
- migration count and last migration;
- Node and pnpm versions;
- timestamp and operator.

A different SHA requires a new acceptance run.

## Operational checklist

### Infrastructure

- [ ] Deployment model from ADR-010 decided from server evidence.
- [ ] Exact release SHA deployed atomically.
- [ ] TLS certificates valid for every public host.
- [ ] Reverse proxy topology matches `API_TRUST_PROXY=loopback`.
- [ ] API is not exposed directly around the reverse proxy.
- [ ] PostgreSQL backup exists and restore has been rehearsed.
- [ ] Rollback procedure is documented and tested outside production.
- [ ] Disk, memory, restart behaviour and log retention checked.

### Configuration

- [ ] `APP_ENV=production`.
- [ ] Public browser URLs use HTTPS.
- [ ] Production CSP is present on every frontend.
- [ ] Production auth/HMAC/TOTP/payment keys are unique and kept outside Git.
- [ ] SANDBOX payment mode and TEST malware scanner are disabled/refused.
- [ ] Approved private object storage is configured.
- [ ] Customer, STAFF and Crew origin allow-lists contain only intended hosts.

### Access and operations

- [ ] Initial SUPER_ADMIN bootstrap completed.
- [ ] STAFF MFA enrollment and recovery exercised.
- [ ] Crew login and offline/reconnect exercised on a pilot device.
- [ ] Expired-auth-artifact purge scheduled and monitored.
- [ ] Audit-log access reviewed.
- [ ] Incident, finance and reporting permissions reviewed with pilot operators.

### Business pilot path

Using synthetic or explicitly authorized pilot data only:

- [ ] route, vehicle, seat map and pricing selected/published;
- [ ] trip scheduled;
- [ ] trip discoverable from Booking;
- [ ] booking confirmed with the approved payment adapter;
- [ ] passenger documents attached/verified;
- [ ] baggage, check-in and boarding executed;
- [ ] departure readiness evaluated and departure authorized;
- [ ] departure/arrival recorded;
- [ ] tracking projection checked;
- [ ] incidents closed or explicitly owned;
- [ ] finance and reporting reconciled for the trip.

### Monitoring and support

- [ ] `/health/live` and `/health/ready` monitored.
- [ ] Alert/contact owner known for API/database/payment/storage failures.
- [ ] Authentication incident runbook accessible.
- [ ] Passenger-document reconciliation runbook accessible.
- [ ] Rollback decision owner named for the pilot window.

## Acceptance record

| Field                   | Value      |
| ----------------------- | ---------- |
| candidate SHA           |            |
| CI run                  |            |
| CodeQL run              |            |
| migration status        |            |
| automated pilot browser |            |
| infrastructure owner    |            |
| business pilot owner    |            |
| rollback owner          |            |
| unresolved risks        |            |
| decision                | GO / NO-GO |
| decision timestamp      |            |

## Decision rule

GO requires every automated gate green and every mandatory operational check
completed for the exact candidate SHA. Anything else is NO-GO.

A known limitation may be accepted only when written in the acceptance record
with an owner and explicit decision. A failing security, migration, readiness,
data-integrity or authorization gate cannot be waived for the pilot.

## Current limitation

ADR-010 still marks the production deployment model as undecided. PR-25 can
prove that an application candidate is pilot-acceptable in CI, but it cannot
truthfully declare a production deployment accepted until the server-specific
deployment, rollback and backup checklist is completed.
