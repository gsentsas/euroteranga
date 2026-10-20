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

The deployment builds before switching, backs up PostgreSQL before migration,
applies migrations, switches current atomically, restarts all services and
performs loopback health checks. Proxy cutover validates nginx and public HTTPS.

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

The real payment adapters stay off on the pilot: `deploy-release.sh` sources
`infrastructure/plesk/pilot-env-guard.sh`, which refuses to deploy unless
`APP_ENV=staging`, `PAYMENT_PROVIDER=DISABLED`, `PAYMENT_STRIPE_MODE`,
`PAYMENT_PAYPAL_MODE`, `PAYMENT_WAVE_MODE` and
`PAYMENT_ORANGE_MONEY_MODE` are unset or `DISABLED`, and no Stripe, PayPal,
Wave or Orange Money
credential is present (`PAYMENT_STRIPE_SECRET_KEY`,
`PAYMENT_STRIPE_WEBHOOK_SECRET`, `PAYMENT_PAYPAL_CLIENT_ID`,
`PAYMENT_PAYPAL_CLIENT_SECRET`, `PAYMENT_PAYPAL_WEBHOOK_ID`,
`PAYMENT_WAVE_API_KEY`, `PAYMENT_WAVE_WEBHOOK_SECRET`,
`PAYMENT_WAVE_REQUEST_SIGNING_SECRET`, ni aucune autre variable non vide
`PAYMENT_ORANGE_MONEY_*`). See
[stripe-europe.md](../payments/stripe-europe.md) and
[paypal.md](../payments/paypal.md),
[wave-senegal.md](../payments/wave-senegal.md) et
[orange-money-senegal.md](../payments/orange-money-senegal.md).

A complete business pilot requiring real payment or passenger-document upload
remains NO-GO until a real PSP adapter, private S3-compatible storage and
CLAMAV (or another supported approved scanner) are provisioned.
