# ADR-010 — Plesk deployment target

## Status

Proposed — **Deployment model: NOT YET DECIDED**

## Context

Production is a Plesk server running Ubuntu 24.04 LTS, shared with other
hosted projects. (Exact component versions are kept out of this public
repository.) The Phase 0 baseline (2026-10-12) found:

- the EURO TERANGA Plesk subscription exists but was not accessible from the
  audit session, so its vhost layout and permissions are unverified;
- Node.js 22 and 24 are available through Plesk, Phusion Passenger is
  installed, Docker and systemd are present, PostgreSQL 16 runs locally;
- free disk space was limited;
- no valid TLS certificate was issued yet for the EURO TERANGA hosts.

The monorepo produces six Next.js frontends and one NestJS API, later workers.

## Decision

No deployment model is chosen in PR-01. The three candidates will be compared
after access to the EURO TERANGA subscription and a dedicated audit:

| Option | Description                                     | To verify                                                     |
| ------ | ----------------------------------------------- | ------------------------------------------------------------- |
| A      | Plesk Node.js extension / Passenger             | Fit for 7 apps + workers, restart behaviour, logs, memory     |
| B      | systemd services behind the Plesk reverse proxy | Root access to manage units, release switching, journald logs |
| C      | Docker Compose behind the Plesk reverse proxy   | Docker access for the subscription, isolation, image storage  |

Criteria: stability, restart, isolation, simplicity, logs, rollback, memory and
disk footprint, and compatibility with Plesk-managed TLS and vhosts.

Whatever the option, deployments must be atomic releases built from a single
commit SHA, with health checks before switching and a documented rollback.

## Consequences

- PR-01 contains no deployment configuration and no production change.
- Choices made in PR-01 keep all options open: the API binds to a configurable
  host (loopback by default), handles SIGTERM gracefully and exposes
  liveness/readiness probes; Node 24 LTS is available through Plesk.
- Production PostgreSQL (host cluster vs. container) is decided with this ADR.

## Alternatives considered

Listed above; to be evaluated with evidence from the server audit.
