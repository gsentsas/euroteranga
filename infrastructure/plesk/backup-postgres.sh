#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=/var/www/vhosts/euroteranga.com
BACKUP_DIR="$APP_ROOT/backups/daily"
RETENTION_DAYS="${EUROTERANGA_BACKUP_RETENTION_DAYS:-14}"

[ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL is required" >&2; exit 1; }
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || { echo "Invalid retention: $RETENTION_DAYS" >&2; exit 2; }
[ "$RETENTION_DAYS" -ge 1 ] && [ "$RETENTION_DAYS" -le 365 ] || {
  echo "Retention must be between 1 and 365 days" >&2
  exit 2
}

umask 077
install -d -m 0700 "$BACKUP_DIR"

exec 9>"$BACKUP_DIR/.backup.lock"
if ! flock -n 9; then
  echo "A PostgreSQL backup is already running; nothing to do."
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$BACKUP_DIR/daily-$STAMP.dump"
TMP="$BACKUP_DIR/.daily-$STAMP.dump.tmp.$$"
CHECKSUM="$FINAL.sha256"
CHECKSUM_TMP="$BACKUP_DIR/.daily-$STAMP.sha256.tmp.$$"

cleanup() {
  rm -f -- "$TMP" "$CHECKSUM_TMP"
}
trap cleanup EXIT HUP INT TERM

pg_dump "$DATABASE_URL"   --format=custom   --no-owner   --no-privileges   --file="$TMP"

# A custom-format dump must be readable by pg_restore before it becomes visible
# as a completed backup.
pg_restore --list "$TMP" >/dev/null

chmod 0600 "$TMP"
mv "$TMP" "$FINAL"
sha256sum "$FINAL" >"$CHECKSUM_TMP"
chmod 0600 "$CHECKSUM_TMP"
mv "$CHECKSUM_TMP" "$CHECKSUM"

# Retention applies only to the dedicated daily-* namespace. Pre-migration
# dumps produced by deploy-release.sh live one directory above and are never
# touched here.
while IFS= read -r -d '' old_dump; do
  rm -f -- "$old_dump" "$old_dump.sha256"
done < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'daily-*.dump'     -mtime "+$RETENTION_DAYS" -print0
)

trap - EXIT HUP INT TERM
echo "BACKUP_CREATED=$FINAL"
echo "BACKUP_RETENTION_DAYS=$RETENTION_DAYS"
