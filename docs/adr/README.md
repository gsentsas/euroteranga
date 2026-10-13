# Architecture Decision Records

Each ADR records one decision: its context, the decision, its consequences and
the alternatives considered. Numbers follow the master plan; gaps are ADRs not
written yet.

| ADR                                                    | Title                                            | Status   |
| ------------------------------------------------------ | ------------------------------------------------ | -------- |
| [ADR-001](ADR-001-modular-monolith.md)                 | Modular monolith                                 | Accepted |
| [ADR-002](ADR-002-postgresql.md)                       | PostgreSQL, Prisma and baseline                  | Accepted |
| [ADR-003](ADR-003-nestjs-api.md)                       | NestJS Core API                                  | Accepted |
| [ADR-004](ADR-004-refine-backoffice.md)                | Refine Community for back-office                 | Accepted |
| [ADR-010](ADR-010-plesk-deployment-target.md)          | Plesk deployment target                          | Proposed |
| [ADR-011](ADR-011-monorepo-tooling.md)                 | Monorepo tooling                                 | Accepted |
| [ADR-012](ADR-012-identity-realms.md)                  | Identity realms                                  | Accepted |
| [ADR-013](ADR-013-session-authentication.md)           | Session authentication                           | Accepted |
| [ADR-014](ADR-014-password-security.md)                | Password security                                | Accepted |
| [ADR-015](ADR-015-staff-mfa.md)                        | Staff MFA                                        | Accepted |
| [ADR-016](ADR-016-csrf-cross-origin-authentication.md) | CSRF and cross-origin authentication             | Accepted |
| [ADR-017](ADR-017-server-side-rbac.md)                 | Server-side RBAC                                 | Accepted |
| [ADR-018](ADR-018-privileged-audit-trail.md)           | Privileged audit trail                           | Accepted |
| [ADR-019](ADR-019-controlled-staff-provisioning.md)    | Controlled STAFF provisioning                    | Accepted |
| [ADR-020](ADR-020-initial-super-admin-bootstrap.md)    | Initial SUPER_ADMIN bootstrap                    | Accepted |
| [ADR-021](ADR-021-route-versioning.md)                 | Versioned, immutable route geometry              | Accepted |
| [ADR-022](ADR-022-vehicle-lifecycle.md)                | Vehicle lifecycle and retirement                 | Accepted |
| [ADR-023](ADR-023-trip-lifecycle.md)                   | Trip lifecycle and immutable scheduled timetable | Accepted |
| [ADR-024](ADR-024-seat-map-versioning.md)              | Seat-map versioning and historical trip layout   | Accepted |

Planned: ADR-005 Object Storage, ADR-007 Offline Crew,
ADR-008 Payment Abstraction, ADR-009 Regulatory Versioning. ADR-006
(Authentication) is covered in detail by ADR-012 to ADR-016; authorization
by ADR-017 to ADR-020.

Business-domain decisions: ADR-021 (route versioning and immutable published
geometry), ADR-022 (vehicle lifecycle and retirement), ADR-023 (trip
lifecycle and immutable scheduled timetable) and ADR-024 (seat-map versioning
and historical trip layout).
