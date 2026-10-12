# ADR-012 — Identity realms

## Status

Accepted — 2026-10-12 (PR-02 Identity & Authentication)

## Context

Three populations authenticate: customers (public, self-service), staff
(back-office, high privilege) and crew (drivers and on-board staff). Their
risk, session lifetime and second-factor needs differ. Authentication must
not be confused with authorization (PR-03) nor with business objects
(customer, passenger, crew member), which will reference an identity later.

## Decision

- One table `auth_identity` with a `realm` column (`CUSTOMER`, `STAFF`,
  `CREW`). An identity can authenticate in exactly one realm. A realm is not a
  role: `STAFF` grants no permission by itself.
- Uniqueness is `UNIQUE(realm, normalized_email)`: the same address may exist
  as two unrelated identities in two realms, with separate credentials and
  sessions. Privileges are never merged implicitly.
- Sessions are bound to their realm server-side: each realm has its own
  cookie, its own allowed origins and its own lifetimes, and a session is
  rejected if its identity belongs to another realm.
- Only customers can self-register. Staff and crew identities are provisioned
  by a future administrative process (PR-03); no public `/staff/register` or
  `/crew/register` exists.
- Status: `PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`, `DISABLED`. Only
  `ACTIVE` identities can sign in. No `DELETED` status until a complete GDPR
  deletion policy exists.
- Internal ids are UUIDv7 (non-sequential, never auto-increment).
- **Pre-account-hijacking defence**: the password chosen at registration is
  kept on the email verification token and becomes the credential only when
  that token is verified _together with the same password_. Someone who
  pre-registers a victim's address cannot end up owning the account the victim
  later activates.

## Consequences

- PR-03 attaches roles and permissions to identities of the `STAFF` (and
  possibly `CREW`) realm; the `AuthPrincipal` (identity id, realm, session id)
  is the input of authorization.
- Verifying an email asks for the password again (one extra field).
- A user with accounts in two realms manages two passwords.

## Alternatives considered

- **One identity, several roles across realms** — merges customer and staff
  privileges behind one credential; a customer-side compromise would reach
  the back-office.
- **Separate tables per realm** — duplicated schema and logic for no gain.
- **Global email uniqueness** — forces an artificial link between a person's
  customer and staff accounts.
