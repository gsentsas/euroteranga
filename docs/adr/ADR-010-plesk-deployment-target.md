# ADR-010 — Plesk deployment target

## Status

Accepted — 2026-10-17

## Context

A dedicated server audit on 2026-10-17 resolved the unknowns from the original proposal:

- the euroteranga.com Plesk subscription is accessible;
- Plesk Obsidian 18.0.81.3, Node.js 24, systemd, Docker and PostgreSQL 16 are available;
- the subscription user is unprivileged, while server administration can manage systemd/Plesk;
- more than 200 GiB of disk and about 11 GiB of available RAM were observed;
- a valid Let's Encrypt certificate covers euroteranga.com and *.euroteranga.com;
- all public EURO TERANGA hosts resolve to the server and validate TLS;
- ports 3200-3299 were free at audit time;
- the local PostgreSQL 16 cluster is healthy;
- no EURO TERANGA runtime service, role or database existed before this decision.

The monorepo produces six Next.js frontends and one NestJS Core API.

## Decision

EURO TERANGA uses **systemd services behind Plesk-managed nginx/TLS**, with a
dedicated database on the **host PostgreSQL 16 cluster**.

| Surface        | Public host              | Loopback port |
| -------------- | ------------------------ | ------------: |
| Public website | euroteranga.com          |          3200 |
| Booking        | booking.euroteranga.com  |          3201 |
| Client account | client.euroteranga.com   |          3202 |
| Tracking       | tracking.euroteranga.com |          3203 |
| OPS            | ops.euroteranga.com      |          3204 |
| Crew           | crew.euroteranga.com     |          3205 |
| Core API       | api.euroteranga.com      |          3206 |

Every application binds to 127.0.0.1. Plesk terminates TLS and forwards to the
matching loopback port. The API uses API_TRUST_PROXY=loopback.

### Release model

Immutable releases are named by Git SHA under releases/<sha>, with current as
an atomic symlink. The candidate release is fetched from main, installed and
built before the symlink changes. A PostgreSQL custom-format backup is taken
immediately before migration. Application health failure restores the previous
symlink. Database schema rollback is an explicit operator action.

### Secret separation

API secrets live in .secrets/api.env. Frontend processes read only
.secrets/public.env and do not inherit database/authentication secrets.

### Pilot mode

The first public runtime is staging/pilot, not final production. Unsupported
adapters remain fail-closed: PAYMENT_PROVIDER=DISABLED,
OBJECT_STORAGE_PROVIDER=DISABLED and MALWARE_SCANNER=DISABLED.

A business-production GO is blocked until real payment and approved private
document-storage/scanning adapters exist.

## Alternatives rejected

Passenger is available but is not selected for seven separately addressed
processes plus future workers. Explicit systemd units provide clearer restart,
resource limits, journald logs and release switching.

Docker is available, but seven application containers plus another PostgreSQL
container would duplicate host services and increase image/disk management on
a shared Plesk server.

## Consequences

- root access is required for one-time unit/vhost installation;
- application processes always run as the EURO TERANGA subscription user;
- Plesk remains certificate owner/renewer;
- the API is never bound publicly;
- deployments and rollbacks are deterministic and SHA-based;
- missing payment/document production adapters stay visible NO-GO items.
