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

1. Create pilot DB/secrets:
   \`bash infrastructure/plesk/bootstrap-pilot-env.sh\`
2. Install units:
   \`bash infrastructure/plesk/install-systemd.sh\`
3. Deploy exact main SHA:
   \`bash infrastructure/plesk/deploy-release.sh <40-char-main-sha>\`
4. After loopback health is green, cut over Plesk:
   \`bash infrastructure/plesk/configure-plesk-proxy.sh\`

The deployment builds before switching, backs up PostgreSQL before migration,
applies migrations, switches current atomically, restarts all services and
performs loopback health checks. Proxy cutover validates nginx and public HTTPS.

## Observability

- \`systemctl status 'euroteranga-*.service'\`
- \`journalctl -u euroteranga-api.service -n 200 --no-pager\`
- Plesk logs: \`/var/www/vhosts/system/<host>/logs/\`

## Rollback

- \`bash infrastructure/plesk/rollback-release.sh\`
- or \`bash infrastructure/plesk/rollback-release.sh <known-release-sha>\`

Code rollback does not reverse database migrations. Pre-migration dumps are
stored in \`/var/www/vhosts/euroteranga.com/backups/\`.

## Pilot NO-GO items

The first staging deployment intentionally uses PAYMENT_PROVIDER=DISABLED,
OBJECT_STORAGE_PROVIDER=DISABLED and MALWARE_SCANNER=DISABLED.

A complete business pilot requiring real payment or passenger-document upload
remains NO-GO until a real PSP adapter, private S3-compatible storage and
CLAMAV (or another supported approved scanner) are provisioned.
