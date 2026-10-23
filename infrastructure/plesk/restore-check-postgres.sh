#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=/var/www/vhosts/euroteranga.com
APP_USER=euroteranga.com_5p804yhows7
BACKUP_DIR="$APP_ROOT/backups/daily"
MAX_AGE_HOURS="${EUROTERANGA_BACKUP_MAX_AGE_HOURS:-36}"

[ "$(id -u)" -eq 0 ] || { echo "Must run as root" >&2; exit 1; }
[[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || { echo "Invalid max age: $MAX_AGE_HOURS" >&2; exit 2; }
[ "$MAX_AGE_HOURS" -ge 1 ] && [ "$MAX_AGE_HOURS" -le 168 ] || {
  echo "Max age must be between 1 and 168 hours" >&2
  exit 2
}

LATEST="$(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'daily-*.dump' -printf '%f\n' 2>/dev/null |
    sort |
    tail -n 1
)"
[ -n "$LATEST" ] || { echo "No daily PostgreSQL backup found" >&2; exit 1; }
LATEST="$BACKUP_DIR/$LATEST"
CHECKSUM="$LATEST.sha256"
[ -f "$CHECKSUM" ] || { echo "Missing checksum for $LATEST" >&2; exit 1; }

NOW="$(date +%s)"
MTIME="$(stat -c %Y "$LATEST")"
AGE_SECONDS="$((NOW - MTIME))"
MAX_AGE_SECONDS="$((MAX_AGE_HOURS * 3600))"
[ "$AGE_SECONDS" -ge 0 ] && [ "$AGE_SECONDS" -le "$MAX_AGE_SECONDS" ] || {
  echo "Latest backup is stale: $LATEST" >&2
  exit 1
}

(
  cd "$BACKUP_DIR"
  sha256sum --check --strict "$(basename "$CHECKSUM")"
)

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CHECK_DB="euroteranga_restore_check_${STAMP//[^0-9A-Za-z]/}_$$"
# PostgreSQL identifiers are limited to 63 bytes. The generated name is fixed
# to this prefix plus UTC timestamp/PID and never derives from user input.
CHECK_DB="${CHECK_DB:0:63}"

drop_check_db() {
  runuser -u postgres -- dropdb --if-exists --maintenance-db=template1 "$CHECK_DB" >/dev/null 2>&1 || true
}
trap drop_check_db EXIT HUP INT TERM

runuser -u postgres -- createdb --maintenance-db=template1 -T template0 "$CHECK_DB"

# The dump stays mode 0600 under the application account. Root opens it and
# streams it to pg_restore running as postgres, so the postgres OS account does
# not need filesystem access to the backup directory.
cat "$LATEST" |
  runuser -u postgres -- pg_restore     --exit-on-error     --no-owner     --no-privileges     --dbname="$CHECK_DB"

MIGRATIONS_PRESENT="$(
  runuser -u postgres -- psql -X -d "$CHECK_DB" -Atqc     "select (to_regclass('public._prisma_migrations') is not null)::text"
)"
[ "$MIGRATIONS_PRESENT" = "true" ] || {
  echo "Restore check failed: Prisma migration history is missing" >&2
  exit 1
}

drop_check_db
trap - EXIT HUP INT TERM

MARKER="$BACKUP_DIR/.last-restore-check"
MARKER_TMP="$BACKUP_DIR/.last-restore-check.tmp.$$"
printf 'verified_at=%s\nbackup=%s\nsha256=%s\n'   "$(date -u +%Y-%m-%dT%H:%M:%SZ)"   "$(basename "$LATEST")"   "$(sha256sum "$LATEST" | awk '{print $1}')" >"$MARKER_TMP"
chown "$APP_USER":psacln "$MARKER_TMP"
chmod 0600 "$MARKER_TMP"
mv "$MARKER_TMP" "$MARKER"

echo "RESTORE_CHECK=PASS"
echo "VERIFIED_BACKUP=$LATEST"
echo "BACKUP_AGE_SECONDS=$AGE_SECONDS"
