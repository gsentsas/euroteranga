# Architecture Decision Records

Each ADR records one decision: its context, the decision, its consequences and
the alternatives considered. Numbers follow the master plan; gaps are ADRs not
written yet.

| ADR                                                                     | Title                                                  | Status   |
| ----------------------------------------------------------------------- | ------------------------------------------------------ | -------- |
| [ADR-001](ADR-001-modular-monolith.md)                                  | Modular monolith                                       | Accepted |
| [ADR-002](ADR-002-postgresql.md)                                        | PostgreSQL, Prisma and baseline                        | Accepted |
| [ADR-003](ADR-003-nestjs-api.md)                                        | NestJS Core API                                        | Accepted |
| [ADR-004](ADR-004-refine-backoffice.md)                                 | Refine Community for back-office                       | Accepted |
| [ADR-005](ADR-005-private-object-storage-quarantine.md)                 | Private object storage, scanning and quarantine        | Accepted |
| [ADR-009](ADR-009-versioned-regulatory-rule-engine.md)                  | Versioned regulatory rule engine                       | Accepted |
| [ADR-010](ADR-010-plesk-deployment-target.md)                           | Plesk deployment target                                | Proposed |
| [ADR-011](ADR-011-monorepo-tooling.md)                                  | Monorepo tooling                                       | Accepted |
| [ADR-012](ADR-012-identity-realms.md)                                   | Identity realms                                        | Accepted |
| [ADR-013](ADR-013-session-authentication.md)                            | Session authentication                                 | Accepted |
| [ADR-014](ADR-014-password-security.md)                                 | Password security                                      | Accepted |
| [ADR-015](ADR-015-staff-mfa.md)                                         | Staff MFA                                              | Accepted |
| [ADR-016](ADR-016-csrf-cross-origin-authentication.md)                  | CSRF and cross-origin authentication                   | Accepted |
| [ADR-017](ADR-017-server-side-rbac.md)                                  | Server-side RBAC                                       | Accepted |
| [ADR-018](ADR-018-privileged-audit-trail.md)                            | Privileged audit trail                                 | Accepted |
| [ADR-019](ADR-019-controlled-staff-provisioning.md)                     | Controlled STAFF provisioning                          | Accepted |
| [ADR-020](ADR-020-initial-super-admin-bootstrap.md)                     | Initial SUPER_ADMIN bootstrap                          | Accepted |
| [ADR-021](ADR-021-route-versioning.md)                                  | Versioned, immutable route geometry                    | Accepted |
| [ADR-022](ADR-022-vehicle-lifecycle.md)                                 | Vehicle lifecycle and retirement                       | Accepted |
| [ADR-023](ADR-023-trip-lifecycle.md)                                    | Trip lifecycle and immutable scheduled timetable       | Accepted |
| [ADR-024](ADR-024-seat-map-versioning.md)                               | Seat-map versioning and historical trip layout         | Accepted |
| [ADR-025](ADR-025-versioned-fare-tables-historical-trip-pricing.md)     | Versioned fare tables and historical trip pricing      | Accepted |
| [ADR-026](ADR-026-segment-inventory-booking-holds.md)                   | Segment-based seat inventory and customer holds        | Accepted |
| [ADR-027](ADR-027-payment-provider-abstraction-booking-confirmation.md) | Payment provider abstraction and booking confirmation  | Accepted |
| [ADR-028](ADR-028-baggage-identity-event-history.md)                    | Baggage identity, exact weight and append-only events  | Accepted |
| [ADR-029](ADR-029-operational-boarding-credential.md)                   | Operational boarding credential and readiness snapshot | Accepted |
| [ADR-030](ADR-030-immutable-trip-passenger-manifests.md)                | Immutable trip passenger manifests                     | Accepted |
| [ADR-031](ADR-031-regulatory-permit-lifecycle.md)                       | Regulatory permit lifecycle and intrinsic validity     | Accepted |

Planned: ADR-007 Offline Crew. The planned
ADR-008 (Payment Abstraction) is covered by ADR-027. ADR-006
(Authentication) is covered in detail by ADR-012 to ADR-016; authorization
by ADR-017 to ADR-020.

Business-domain decisions: ADR-021 (route versioning and immutable published
geometry), ADR-022 (vehicle lifecycle and retirement), ADR-023 (trip
lifecycle and immutable scheduled timetable), ADR-024 (seat-map versioning
and historical trip layout), ADR-025 (versioned fare tables and historical
trip pricing), ADR-026 (segment-based inventory and customer booking holds)
and ADR-027 (payment provider abstraction and booking confirmation).
ADR-005 covers the cross-cutting private object-store, malware-scanning and
logical-quarantine boundary used by passenger documents.
ADR-009 covers the PR-12 versioned regulatory rule engine, evaluation and
human review of passenger compliance.
ADR-028 covers the PR-13 baggage identity, PII-free QR payload, exact weight
and append-only event history. ADR-029 covers the PR-14 check-in readiness
snapshot and fingerprint and the opaque, re-validated boarding credential.
ADR-030 covers PR-15 immutable, minimized and versioned trip passenger
snapshots and their on-demand CSV representation. ADR-031 separates generic,
scoped operational permits and intrinsic validity from passenger compliance,
technical documents, manifests and PR-17 departure readiness.
