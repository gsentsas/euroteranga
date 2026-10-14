# Baggage security and privacy

Baggage data links a physical object to a named traveller on a concrete
journey. It is **PII**: the passenger name, the booking and the trip.

The QR code and the public reference carry none of it. This document covers
PR-13's technical controls. The domain model is described in
[docs/domain/baggage.md](../domain/baggage.md).

## Security review

| Threat                         | Control                                                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IDOR (customer)                | Every CUSTOMER query joins the booking owner and, for registration, the passenger owner. A foreign bag, a foreign booking or a mismatched booking/passenger pair gives the same 404 body as an unknown one.                                                              |
| Mass assignment                | Strict schemas: a CUSTOMER sends only `{ type }`. `customerId`, `tripId`, `passengerId`, `bookingId`, `measuredWeightKg`, `status`, allowance or charge fields are refused (400). The subject is derived on the server from the two public references.                   |
| QR as authority                | The QR holds `ETG1:<reference>` only. Resolving or scanning it needs a STAFF session, `ops.access` and `baggage.read`/`baggage.manage`, and goes through the same lookup, transition checks, transaction and audit as any other event. There is no public baggage route. |
| QR content / PII               | The payload is derived from the opaque reference only. Tests prove that the SVG equals the rendering of `ETG1:<reference>` and contains no name or booking.                                                                                                              |
| SVG injection                  | The SVG is generated locally from a validated reference, contains only static shapes, and is rendered as an `<img>` data URI, never injected as markup. It is served as JSON with `nosniff` and `private, no-store`.                                                     |
| Weight authority and precision | Weight is written only through `baggage.manage` STAFF routes. Exact decimal strings are validated by pattern, stored as `numeric(6,3)` with CHECKs, and returned as strings. No float conversion is made on the server or in the UIs.                                    |
| Status tampering               | There is no route that sets a status. The projection changes only with an event, in the same transaction. PostgreSQL refuses a projection that differs from the latest event, and refuses an event without its projection (deferred constraint triggers).                |
| History tampering              | `baggage_event` refuses `UPDATE`, `DELETE` and `TRUNCATE`. `baggage` refuses `DELETE` and `TRUNCATE`. `REMOVED` is a terminal event, never a deletion.                                                                                                                   |
| Transition bypass              | The API pure function and the PostgreSQL trigger apply the same matrix: linear lifecycle, one active exception that blocks progress, terminal `REMOVED`, and `REGISTERED` only as the first event.                                                                       |
| Race conditions                | Each event locks the bag row (API and trigger). The sequence must be the previous one plus 1, and is unique per bag. Forced-overlap tests on real PostgreSQL prove that nothing is duplicated, lost or mismatched.                                                       |
| Replay / duplicate scans       | `client_event_id` is unique per bag, and the payload fingerprint is compared: same id and same payload return the original event; same id with a different payload gives 409.                                                                                            |
| Backdating                     | `occurred_at` is bounded by the booking creation, now − 30 days and now + 5 minutes (API and trigger). `recorded_at` is always the server clock.                                                                                                                         |
| Cross-route location           | An event waypoint must belong to the route version of the bag's trip (trigger, 422).                                                                                                                                                                                     |
| Inactive or wrong actor        | Operational events need an ACTIVE STAFF identity (trigger). Only the booking customer or STAFF can be the actor of the initial event.                                                                                                                                    |
| Pricing creep                  | Allowance and charge columns stay `NULL`, and a trigger refuses any change ("no PR-13 policy"). No baggage payment, revenue, refund or credit exists.                                                                                                                    |
| Abuse                          | CUSTOMER registration is limited to 30 per hour per identity. STAFF operations are limited to 600 per 15 minutes per identity. List pages are bounded (≤ 100).                                                                                                           |
| Audit failure                  | Every mutation writes its audit event in the same transaction. An audit failure rolls back the event (tested).                                                                                                                                                           |

## Permissions and least privilege

| Permission       | Grants                                                                                      | Rationale                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `baggage.read`   | `SUPER_ADMIN`, `DIRECTOR`, `OPS_MANAGER`, `DISPATCHER`, `BOOKING_AGENT`, `CUSTOMER_SUPPORT` | Roles that handle travellers or answer them; support only reads.                    |
| `baggage.manage` | `SUPER_ADMIN`, `DIRECTOR`, `OPS_MANAGER`, `DISPATCHER`, `BOOKING_AGENT`                     | Counter registration and weighing (booking agents), loading and transit (dispatch). |

- **No baggage permission:** `AUDITOR`, `FINANCE` and `COMPLIANCE_AGENT` get none. Baggage views name the passenger, and these roles have no traveller-handling duty. The auditor follows changes through the audit trail.
- **No implied access:** `booking.read`, `payment.read`, `compliance.read` and `passenger.document.read` never imply a baggage permission. This is proven by the RBAC matrix and per-role HTTP tests.
- **`baggage.read` is not `baggage.manage`:** reading never allows a write.
- **No `baggage.scan` permission:** a scan is the same operation as an event with a QR lookup, so a separate grant adds no protection.

## Audit

| Action                   | When                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `BAGGAGE_REGISTERED`     | CUSTOMER or STAFF registration (reference, booking/passenger references) |
| `BAGGAGE_WEIGHT_UPDATED` | Exact weight event                                                       |
| `BAGGAGE_EVENT_RECORDED` | Lifecycle, exception or resolution event                                 |
| `BAGGAGE_REMOVED`        | Terminal removal event                                                   |
| `BAGGAGE_ACCESSED`       | STAFF list page, detail, QR label or QR resolution                       |

Events carry business references, the event type, sequence, statuses and the
exact weight.

They never carry passenger names, e-mail addresses, the SVG, `client_event_id`
or fingerprints.

## Privacy review

- **Purpose:** identify and follow a traveller's bag during a confirmed
  journey.
- **Minimization:** the QR and the reference carry no PII. Customer views
  expose no internal UUID, actor or idempotency key. Only roles that handle
  travellers read baggage, and every STAFF read is audited.
- **Retention:** the history is immutable in PR-13. A retention or erasure
  policy stays an open decision shared with PR-11 and PR-12. No automatic
  deletion exists.
- **Environments:** tests and browser runs use synthetic customers,
  travellers and bags only.

## Residual limits

- A printed QR identifies a bag to anyone who reads it. It reveals nothing
  else and grants nothing.
- `client_event_id` is scoped per bag.
- There are no physical label printer integration, offline scanner, check-in,
  boarding, manifest or incident workflow yet (PR-14, PR-15, PR-18, PR-21).
