# Check-in and boarding security and privacy

Check-in and boarding handle operational passenger PII: names, booking, trip
and seat. They also authorize a person to board a vehicle. The boarding QR
carries none of this PII and authorizes nothing. This document covers PR-14's
technical controls; the domain model is described in
[docs/domain/check-in-boarding.md](../domain/check-in-boarding.md).

## Security review

| Threat                 | Control                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDOR (customer)        | Every CUSTOMER route joins the booking owner and the passenger owner. A foreign or unknown booking passenger, booking or check-in gives the same 404 body (readiness, seat, check-in, overview, QR).                                                                            |
| Mass assignment        | Strict schemas. The check-in body is empty, and a seat assignment carries only a seat label. Status, eligibility, compliance, payment, actor, device, override and id fields are refused (400). The booking passenger and seat are derived on the server.                       |
| Check-in bypass        | One server path for CUSTOMER and STAFF derives the six gates under the booking passenger row lock. PostgreSQL re-checks the hard gates in the check-in trigger. There is no force, ignore or skip input, route or button.                                                       |
| Payment bypass         | The PR-10 `SUCCEEDED` payment is read from PostgreSQL (`paid=true` is never trusted). The trigger requires it as well, and PR-10 already ties confirmation to it.                                                                                                               |
| Document bypass        | No document rule is coded. Documents are judged by the current PR-12 evaluation; its evidence must still be technically `ACCEPTED`, and `QUARANTINED` or `REJECTED` files are never proof.                                                                                      |
| Compliance bypass      | Only a current PR-12 `COMPLIANT_BY_RULES` or `COMPLIANT` status passes. The trigger requires the latest evaluation of the same passenger with a `PASS` result or a non-superseded `COMPLIANT` review.                                                                           |
| Stale compliance       | Staleness is recomputed by PR-12 at check-in and at every scan. A stale evaluation blocks (`COMPLIANCE_STALE`, `DOCUMENTS_NOT_VERIFIED`).                                                                                                                                       |
| Seat mismatch          | Composite foreign keys keep the seat and the passenger on the same booking. The seat must be unreleased. The check-in pins the assignment through a foreign key with `ON UPDATE RESTRICT`, and a trigger freezes the seat after check-in.                                       |
| Seat race              | `UNIQUE (booking_seat_id)` plus a share lock on the seat. A forced-overlap test proves that one of two simultaneous assignments wins and the other gets 409.                                                                                                                    |
| Baggage blocker bypass | The baggage gate reads PR-13 projections. An active exception blocks, and `REMOVED` is history. It is re-derived at boarding.                                                                                                                                                   |
| QR enumeration         | The credential is `ETQ-` + 16 CSPRNG characters (80 bits). Resolve and scan require an authenticated STAFF session with `boarding.read` and `boarding.scan`. Unknown credentials get the same 404 for resolve and scan, and malformed or unsupported payloads get 422.          |
| QR PII                 | The payload is `ETPAX1:<credential>` only. Tests prove the SVG equals the rendering of that payload and contains no name, booking, passenger or trip reference.                                                                                                                 |
| QR as authorization    | The QR only identifies a check-in. Every scan re-derives every gate under a row lock; an old QR cannot get around a new blocker (`CHECK_IN_STALE`, audited).                                                                                                                    |
| Credential replay      | A replay with the same `deviceId` + `clientEventId` and the same payload returns the original boarding. Anything else on a boarded passenger is a stable 409, and no second row is ever written.                                                                                |
| Double boarding        | `UNIQUE (check_in_id)` plus the check-in row lock. Eight forced-overlap scans and a burst of 30 give exactly one boarding and one `PASSENGER_BOARDED` audit event.                                                                                                              |
| `clientEventId` reuse  | `UNIQUE (device_id, client_event_id)` and a payload fingerprint (credential, device, `occurredAt`). Reuse with a different payload gives `409 BOARDING_CLIENT_EVENT_ID_REUSED`.                                                                                                 |
| `deviceId` trust       | Bounded format (API and CHECK). It is recorded as metadata, never used as identity or authority. Enrollment is PR-18.                                                                                                                                                           |
| `occurredAt` abuse     | Bounded by the check-in time (5-minute skew), now − 30 days and now + 5 minutes (API and trigger). `boarded_at` and `checked_in_at` are server clocks.                                                                                                                          |
| RBAC                   | `checkin.read`, `checkin.manage`, `boarding.read` and `boarding.scan`, deny by default. `checkin.manage` is not `boarding.scan` (the counter agent cannot board). No other permission implies them (RBAC matrix plus per-role HTTP tests). There is no customer boarding route. |
| Audit rollback         | Seat assignment, check-in and boarding audit in the same transaction. An audit failure fails the mutation (tested for check-in and boarding).                                                                                                                                   |
| Stored XSS             | Only server-built codes, references and labels are rendered as text (React escaping). The QR SVG is an `<img>` data URI.                                                                                                                                                        |
| Pagination abuse       | Keyset pagination with at most 25 rows per page. Each page computes bounded readiness and is audited.                                                                                                                                                                           |
| Abuse                  | Rate limits per identity: customer seat and check-in operations 60/h, STAFF counter operations 600/15 min, boarding scans 1200/15 min.                                                                                                                                          |

## Permissions and least privilege

| Permission       | Grants                                                                                      | Rationale                                                    |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `checkin.read`   | `SUPER_ADMIN`, `DIRECTOR`, `OPS_MANAGER`, `DISPATCHER`, `BOOKING_AGENT`, `CUSTOMER_SUPPORT` | Roles that handle travellers; support answers customers.     |
| `checkin.manage` | `SUPER_ADMIN`, `DIRECTOR`, `OPS_MANAGER`, `DISPATCHER`, `BOOKING_AGENT`                     | Counter check-in (booking agents) and departure staff.       |
| `boarding.read`  | `SUPER_ADMIN`, `DIRECTOR`, `OPS_MANAGER`, `DISPATCHER`                                      | Departure operations resolve a QR before boarding.           |
| `boarding.scan`  | `SUPER_ADMIN`, `DIRECTOR`, `OPS_MANAGER`, `DISPATCHER`                                      | Boarding is a departure duty, not a counter or support duty. |

- **No grant:** `AUDITOR`, `FINANCE` and `COMPLIANCE_AGENT` get no grant, because these routes expose operational passenger PII and those roles have no traveller-handling duty.
- **CREW and DRIVER:** they get no grant yet. Their realm has no route here, and the PR-18 Crew application, with device enrollment, will add the boarding route and grant together.

## Privacy review

- **Purpose:** decide whether a booking passenger may check in, issue an operational boarding credential, and record the boarding.
- **Minimization:**
  - the QR holds an opaque credential only;
  - the check-in snapshot holds references, statuses and codes, with no name, birth date, document number, file or compliance facts;
  - audit events carry references, the seat label, codes and the device id.
- **Customer views:** they expose no internal UUID, STAFF identity, device id, fingerprint, snapshot or internal compliance reason.
- **OPS views:** they show only what the operation needs: name, references, seat, gates and boarding time and post.
- **Retention:** check-ins and boardings are immutable history in PR-14. The retention and erasure policy remains open, shared with PR-11 to PR-13.
- **Environments:** synthetic data only in tests and browser runs.

## Residual limits

- `deviceId` is unauthenticated metadata until PR-18.
- There is no check-in window and no un-check-in workflow, because neither is specified.
- A printed or displayed QR identifies a check-in to anyone who reads it. It reveals nothing else and grants nothing.
