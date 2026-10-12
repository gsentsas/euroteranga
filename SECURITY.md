# Security Policy

EURO TERANGA will process personal and sensitive data of travellers, crew and
staff. Security and privacy are requirements, not optional features.

> This repository is **public**. Treat everything committed here as visible to
> anyone, permanently. Git history is not a safe place to "temporarily" store
> anything sensitive: removing a file in a later commit does not remove it from
> history.

## Reporting a vulnerability

**Do not open a public GitHub issue, discussion or pull request containing
exploitable details.**

Instead:

1. Use GitHub's private vulnerability reporting for this repository
   ("Security" tab → "Report a vulnerability"), if enabled; or
2. Contact the repository owner privately through GitHub.

Please include:

- a description of the issue and its potential impact;
- the affected component, URL or file;
- steps to reproduce, if possible;
- any suggested mitigation.

Please do not access, modify or exfiltrate data that does not belong to you,
and do not perform denial-of-service or social engineering testing.

We will acknowledge the report, investigate, and coordinate disclosure once a
fix is available.

## Never commit

The following must never be committed to this repository, in any branch, file,
test fixture, screenshot, log or commit message:

- passwords;
- tokens (API tokens, session tokens, OAuth tokens, CI tokens);
- API keys and payment provider keys;
- private SSH keys and private TLS certificates/keys (`*.pem`, `*.key`, `*.p12`, `*.pfx`);
- `.env` files or any file containing real environment values;
- database connection strings containing credentials (e.g. a real `DATABASE_URL`);
- PostgreSQL credentials;
- Plesk, hosting, DNS or registrar credentials;
- database dumps, backups and production exports;
- traveller documents or any file uploaded by users;
- personal data (PII) of real people.

Only `.env.example` files with obviously fake placeholder values are allowed.

If a secret is committed by mistake:

1. **Revoke / rotate it immediately** — consider it compromised.
2. Then notify the repository owner privately.
3. History rewriting may be decided afterwards, but never replaces rotation.

## Sensitive data

The future platform will handle data that requires particular care. The
following categories are classified as **sensitive** and are subject to strict
access control, audit logging, minimisation and retention rules:

- **Passports** and national identity documents;
- **Residence permits** and visas;
- **Tickets** and booking details linked to identified travellers;
- **Payments** and payment-related data (card data must never be stored by the
  platform itself);
- **Geolocation** of vehicles, crew and trips;
- **Data relating to minors**, including parental authorisations.

Rules that apply from the first line of code:

- No real personal data in seeds, fixtures, tests, demos or screenshots. Use
  clearly fictitious identities.
- Sensitive files are stored in private object storage, never in a web root or
  `public/` directory.
- Logs must never contain full document numbers, uploaded files, passwords,
  tokens, cookies, card data or MFA secrets.
- Access to sensitive documents is authenticated, authorised and audited,
  including read access.
- Staging and development environments never contain non-anonymised real data.

## Supported versions

The project is in pre-development. No version is released or supported yet.
