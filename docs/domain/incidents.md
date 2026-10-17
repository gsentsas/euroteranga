# Operational incidents (PR-21)

PR-21 adds a factual operational incident workflow for trips. It is not an
insurance, claims, compensation, customs-clearance or legal-decision system.
Finance and claims remain outside this domain.

## Scope

An incident belongs to one trip and may optionally reference the trip vehicle,
a route waypoint and, for BAGGAGE incidents only, a baggage item currently
marked MISSING or DAMAGED on the same trip.

Supported types: BREAKDOWN, ACCIDENT, DELAY, BORDER, CUSTOMS, POLICE,
PASSENGER, HEALTH, BAGGAGE, SECURITY, WEATHER, FERRY and OTHER.

Severity is LOW, MEDIUM, HIGH or CRITICAL.

BORDER, CUSTOMS and POLICE are operational labels only. They never mean
customs clearance, immigration approval, visa validity or authorization to
enter a territory.

## State machine

The only status path is:

OPEN -> ASSESSING -> ACTION_REQUIRED -> MITIGATING -> RESOLVED -> CLOSED

PostgreSQL enforces the transition graph. Creation always starts at OPEN.
resolved_at and closed_at are server-owned timestamps.

For a CRITICAL BREAKDOWN, three milestones are mandatory before progression:

1. ACTION_PLAN before ACTION_REQUIRED -> MITIGATING;
2. PASSENGERS_INFORMED before MITIGATING -> RESOLVED;
3. POSTMORTEM before RESOLVED -> CLOSED.

Those milestones are append-only actions, not alternate incident states.

## Append-only evidence

The initial report facts are immutable after creation: trip, vehicle, waypoint,
baggage link, type, severity, source, description, location, occurrence time,
provenance, client event id and payload fingerprint.

Follow-up information is stored in incident_action with a strictly increasing
sequence. UPDATE, DELETE and TRUNCATE are rejected for the action journal.
Closed incidents accept no new actions.

Private evidence uses incident_attachment. Only PDF, JPEG and PNG are
accepted, with bounded size, filename validation, magic-byte validation,
SHA-256 integrity and the existing malware-scanner chain. The object key is
private and is never returned by the API. Metadata rows are immutable and
closed incidents accept no new attachment.

## Idempotence and provenance

Opening an incident is idempotent on (trip_id, client_event_id). The server
stores a SHA-256 payload fingerprint: an exact replay returns the original
incident with created=false; changed content with the same client id conflicts.

Incident actions use the same principle with (incident_id, client_action_id).

STAFF reports record the authenticated STAFF identity. Crew reports additionally
record the active trip assignment and enrolled Crew device. PostgreSQL checks
that the Crew identity, assignment, device and trip still match.

## Baggage boundary

A BAGGAGE incident requires a baggage reference. The baggage must belong to
the same trip and its current exception must be MISSING or DAMAGED.
Non-baggage incidents cannot carry a baggage reference.

PR-21 does not create claims, refunds, compensation amounts or accounting
entries from a baggage incident.

## Permissions

STAFF incident.read lists and reads incident state, journal and attachment
metadata. STAFF incident.manage opens, assigns, progresses and documents
incidents. Crew crew.incident.report reports an incident only for an actively
assigned trip and enrolled device, including through the existing offline sync.

Crew never receives STAFF incident.read or incident.manage.

## API

STAFF routes under /v1/admin/incidents:

- GET / : filtered incident queue;
- GET /owners : active STAFF owners available for assignment;
- GET /:reference : incident detail;
- POST / : open an incident;
- POST /:reference/actions : append an operational action;
- POST /:reference/transition : move to the one next valid status;
- POST /:reference/owner : assign or unassign an active STAFF owner;
- POST /:reference/attachments : private scanned evidence upload;
- GET /:reference/attachments/:attachmentId/download : authorized private download.

Crew may use the dedicated report route or send INCIDENT_REPORTED through the
existing bounded POST /v1/crew/trips/:tripReference/events/sync contract.

## Offline Crew

The Crew PWA reuses the PR-18 IndexedDB queue. INCIDENT_REPORTED carries only
the operational fields required by the server. The original clientEventId and
occurredAt survive reload and retry. Offline success wording means only that
the local IndexedDB transaction committed; server acknowledgement remains a
separate state.

No passenger name, booking reference or other unrelated PII is added to the
offline incident payload.
