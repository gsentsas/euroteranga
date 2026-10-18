# EURO TERANGA pilot deployment runbook

This runbook implements ADR-010 for the public staging/pilot environment.

## Topology

- Plesk/nginx terminates public TLS.
- Seven unprivileged systemd services bind only to 127.0.0.1:3200-3206.
- PostgreSQL 16 runs on the host with a dedicated role/database.
- Releases are immutable Git-SHA directories switched through an atomic current symlink.
- API secrets and frontend public variables use separate environment files.

## First-time bootstrap

Run as root from a checked-out release.

1. Create the pilot database and secrets:
   `bash infrastructure/plesk/bootstrap-pilot-env.sh`
2. Install the units:
   `bash infrastructure/plesk/install-systemd.sh`
3. Deploy an exact `main` SHA:
   `bash infrastructure/plesk/deploy-release.sh <40-char-main-sha>`
4. Once loopback health is green, cut over Plesk:
   `bash infrastructure/plesk/configure-plesk-proxy.sh`

The deployment:

- builds before switching;
- backs up PostgreSQL before migrating, then applies migrations;
- switches `current` atomically and restarts all services;
- waits for readiness (`lib/readiness.sh`).

The readiness wait polls the API health and the six frontends quietly. It
logs one line per service when that service is ready, and stops at once if a
unit enters the failed state. It gives up after `READY_TIMEOUT_SECONDS`
(default 90), listing what never answered. On failure the previous release
is restored automatically and the same wait is applied to it. Proxy cutover
validates nginx and public HTTPS.

## Service units (OPS-DEPLOY-1)

The six frontends start Node and Next.js directly from
`current/apps/<app>`. They no longer go through `pnpm exec`, which turned
every normal stop into `exit-code` failures. After a change under
`infrastructure/plesk/systemd/`, root reinstalls the units before deploying
the release that needs them:

`bash infrastructure/plesk/install-systemd.sh`

A unit listed by `systemctl --failed` is now a real failure.

## HSTS

Every deployed frontend sends
`Strict-Transport-Security: max-age=31536000; includeSubDomains`, the same
value as the Core API. The apex also receives a 6-month HSTS header from its
Plesk SSL settings; both values include sub-domains, so the Plesk one may be
switched off to keep a single source.

`preload` is deliberately not set. Joining the browser preload lists is a
separate, hard-to-reverse owner decision.

## Authentication retention

`install-systemd.sh` installs and starts `euroteranga-auth-purge.timer`.

The timer runs the existing idempotent `auth:purge-expired` CLI once per day,
with up to 30 minutes of randomized delay and `Persistent=true`, so a missed
run is executed after the server returns.

Useful checks:

- `systemctl status euroteranga-auth-purge.timer`
- `systemctl list-timers euroteranga-auth-purge.timer`
- `journalctl -u euroteranga-auth-purge.service -n 100 --no-pager`

The purge deletes only expired/revoked temporary authentication artifacts. It
does not delete identities, durable MFA credentials, security events or audit
events.

## Observability

- `systemctl status 'euroteranga-*.service'`
- `journalctl -u euroteranga-api.service -n 200 --no-pager`
- Plesk logs: `/var/www/vhosts/system/<host>/logs/`

## Rollback

- `bash infrastructure/plesk/rollback-release.sh`
- or `bash infrastructure/plesk/rollback-release.sh <known-release-sha>`

Code rollback does not reverse database migrations. Pre-migration dumps are
stored in `/var/www/vhosts/euroteranga.com/backups/`.

## Pilot NO-GO items

The first staging deployment intentionally uses PAYMENT_PROVIDER=DISABLED,
OBJECT_STORAGE_PROVIDER=DISABLED and MALWARE_SCANNER=DISABLED.

A complete business pilot requiring real payment or passenger-document upload
remains NO-GO until a real PSP adapter, private S3-compatible storage and
CLAMAV (or another supported approved scanner) are provisioned.
