# EURO TERANGA — PostgreSQL backup and restore verification

This runbook covers the repository-managed part of OPS-4. It protects the local
PostgreSQL pilot database with daily dumps and proves that the latest dump can
actually be restored. It does **not** provide an off-site copy; that remains
blocked until the owner chooses B9.

## Layout

- Pre-migration dumps created by deployments stay in:
  `/var/www/vhosts/euroteranga.com/backups/pre-*.dump`
- Daily backups use a separate namespace:
  `/var/www/vhosts/euroteranga.com/backups/daily/daily-*.dump`
- Each completed daily dump has a sibling `.sha256` file.
- The most recent successful restore rehearsal is recorded in:
  `/var/www/vhosts/euroteranga.com/backups/daily/.last-restore-check`

The daily retention job never deletes the pre-migration dumps.

## Schedule

`install-systemd.sh` installs and enables two persistent timers:

- `euroteranga-postgres-backup.timer`: daily at 02:15 UTC, with up to
  30 minutes of randomized delay;
- `euroteranga-postgres-restore-check.timer`: daily at 03:15 UTC, with up to
  20 minutes of randomized delay.

Because both timers use `Persistent=true`, a missed run is executed after the
server returns.

## Backup behavior

`backup-postgres.sh`:

1. requires `DATABASE_URL` from the API environment;
2. serializes runs with `flock`;
3. writes a custom-format `pg_dump` to a temporary file;
4. requires `pg_restore --list` to read the dump before publication;
5. atomically renames the completed dump;
6. writes an SHA-256 checksum;
7. removes only `daily-*.dump` files older than the configured retention.

Default retention is 14 days. The optional
`EUROTERANGA_BACKUP_RETENTION_DAYS` value is accepted only from 1 to 365.

## Restore rehearsal

The restore-check service intentionally runs as root because the pilot database
role is not allowed to create databases. The script:

1. selects the newest `daily-*.dump`;
2. refuses a dump older than 36 hours by default;
3. verifies its SHA-256 checksum;
4. creates a local temporary database whose name always starts with
   `euroteranga_restore_check_`;
5. streams the mode-0600 dump to `pg_restore` running as the local
   `postgres` OS account;
6. requires the restored database to contain Prisma migration history;
7. drops the temporary database on success **and on failure**;
8. writes `.last-restore-check` only after all checks pass.

The script never targets the production database for restore.

The optional `EUROTERANGA_BACKUP_MAX_AGE_HOURS` value is accepted only from
1 to 168. Its default is 36 hours.

## Freshness check

Run:

```bash
bash infrastructure/plesk/check-backup-freshness.sh
```

It returns non-zero unless:

- a recent daily dump exists;
- its checksum exists and validates;
- a recent restore-check marker exists;
- the marker names the **same latest dump**.

This command is suitable for a future external monitoring probe, but OPS-4
does not choose or configure that provider.

## Operator commands

```bash
systemctl status euroteranga-postgres-backup.timer
systemctl status euroteranga-postgres-restore-check.timer
systemctl list-timers 'euroteranga-postgres-*'

# Run one backup now.
systemctl start euroteranga-postgres-backup.service

# Prove the newest dump can be restored into an isolated temporary DB.
systemctl start euroteranga-postgres-restore-check.service

# Inspect logs.
journalctl -u euroteranga-postgres-backup.service -n 100 --no-pager
journalctl -u euroteranga-postgres-restore-check.service -n 100 --no-pager

# Check freshness and last successful rehearsal.
bash /var/www/vhosts/euroteranga.com/current/infrastructure/plesk/check-backup-freshness.sh
cat /var/www/vhosts/euroteranga.com/backups/daily/.last-restore-check
```

## Failure handling

A failed dump never becomes a `daily-*.dump`. A failed restore rehearsal
does not update `.last-restore-check`, so freshness monitoring stays red.

Do not delete the latest dump to silence an alert. Diagnose the failed service
and keep the evidence in journald.

## Remaining external blocker

A local disk failure can still destroy both PostgreSQL and these local dumps.
Before production readiness, choose an off-site backup target and add a
separately reviewed encrypted copy/retention procedure. That decision remains
B9 / the off-site part of F-INF-02.
