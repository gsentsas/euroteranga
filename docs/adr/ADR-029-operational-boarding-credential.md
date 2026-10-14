# ADR-029 — Operational boarding credential and check-in readiness snapshot

- Status: Accepted
- Date: 2026-10-14 (PR-14 Check-in / Boarding)

## Context

Boarding means scanning a passenger QR code. The repository had no passenger
ticket or QR. A check-in depends on six facts owned by earlier domains:

- booking (PR-09);
- payment (PR-10);
- documents (PR-11);
- compliance (PR-12);
- seat (PR-09);
- baggage (PR-13).

Those facts can change between check-in and boarding. A naive design either:

- trusts a stored `checkedIn` flag and a QR at boarding, so a new blocker is ignored; or
- turns the QR into a bearer token, so the QR becomes the authority.

Offline Crew scanners (PR-18) will also retry scans.

## Decision

1. **Subject is the BookingPassenger.** Check-in and boarding apply to one person on one confirmed booking of one trip. A minimal `booking_passenger_seat` links that person to one already booked seat.
2. **Deterministic readiness function.** `checkin-readiness/1` derives six gates from PostgreSQL facts, with stable blocker codes. It reuses PR-10, PR-12 and PR-13 rather than re-implementing them. Documents and compliance are read from the current PR-12 evaluation, with no document rule in code.
3. **Append-only check-in with snapshot and fingerprint.** The one check-in of a BookingPassenger (unique) stores:
   - a minimized snapshot that explains why it was allowed;
   - a fingerprint of every authorization fact.

   PostgreSQL re-checks the hard gates and freezes the seat.

4. **Opaque, versioned boarding credential.**
   - The credential is `ETQ-` + 16 CSPRNG characters, issued only with a successful check-in.
   - The QR encodes `ETPAX1:<credential>` and nothing else.
   - It identifies; it never authorizes, never proves payment or identity, and is not a ticket.
5. **Revalidate at every scan.** Boarding locks the check-in and derives every gate again:
   - **Blocked gates:** the check-in is stale (`CHECK_IN_STALE`, audited).
   - **Changed facts that still pass:** boarding is allowed, and the new fingerprint is recorded.
6. **One boarding, idempotent scans.**
   - `UNIQUE (check_in_id)` makes double boarding impossible.
   - `(device_id, client_event_id)` with a payload fingerprint makes retries return the original boarding.
   - Any other scan of a boarded passenger is a stable 409.

## Consequences

Positive:

- a stale or newly blocked passenger cannot board with an old QR;
- printed or displayed QR codes reveal nothing about the traveller;
- retries from future offline devices are harmless;
- every check-in can be explained later from its snapshot and audit event.

Trade-offs:

- each scan recomputes compliance freshness (a bounded cost per scan);
- there is no un-check-in yet: a stale check-in is fixed by making its gates pass again;
- the fingerprint is a record and a "facts changed" signal, not a boarding condition, so legitimate re-evaluations do not strand passengers.

## Alternatives considered

- **Boolean `checkedIn` on BookingPassenger:** rejected. It loses history and the reasons, and invites silent resets.
- **Refusing boarding whenever the fingerprint changed:** rejected. With one check-in per passenger, a legitimate compliance re-evaluation would block the passenger forever.
- **A signed token (JWT or HMAC) as the QR:** rejected. It turns the QR into a bearer credential and needs key rotation and revocation, while the server must still re-validate everything.
- **A commercial `Ticket` domain:** out of scope. PR-14 needs an operational credential, not a sales document.
- **Checking baggage in with the passenger:** rejected. Passenger and baggage workflows stay separate; the baggage gate only reads PR-13.
