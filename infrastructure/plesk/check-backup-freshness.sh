#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=/var/www/vhosts/euroteranga.com
BACKUP_DIR="$APP_ROOT/backups/daily"
MAX_AGE_HOURS="${EUROTERANGA_BACKUP_MAX_AGE_HOURS:-36}"
MARKER="$BACKUP_DIR/.last-restore-check"

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
[ -n "$LATEST" ] || { echo "BACKUP_FRESHNESS=FAIL reason=no-backup" >&2; exit 1; }
LATEST="$BACKUP_DIR/$LATEST"
[ -f "$LATEST.sha256" ] || { echo "BACKUP_FRESHNESS=FAIL reason=no-checksum" >&2; exit 1; }
[ -f "$MARKER" ] || { echo "BACKUP_FRESHNESS=FAIL reason=no-restore-check" >&2; exit 1; }

NOW="$(date +%s)"
LIMIT="$((MAX_AGE_HOURS * 3600))"
BACKUP_AGE="$((NOW - $(stat -c %Y "$LATEST")))"
VERIFY_AGE="$((NOW - $(stat -c %Y "$MARKER")))"

[ "$BACKUP_AGE" -ge 0 ] && [ "$BACKUP_AGE" -le "$LIMIT" ] || {
  echo "BACKUP_FRESHNESS=FAIL reason=stale-backup age_seconds=$BACKUP_AGE" >&2
  exit 1
}
[ "$VERIFY_AGE" -ge 0 ] && [ "$VERIFY_AGE" -le "$LIMIT" ] || {
  echo "BACKUP_FRESHNESS=FAIL reason=stale-restore-check age_seconds=$VERIFY_AGE" >&2
  exit 1
}

(
  cd "$BACKUP_DIR"
  sha256sum --check --strict "$(basename "$LATEST").sha256" >/dev/null
)

grep -Fxq "backup=$(basename "$LATEST")" "$MARKER" || {
  echo "BACKUP_FRESHNESS=FAIL reason=latest-not-restore-checked" >&2
  exit 1
}

echo "BACKUP_FRESHNESS=PASS"
echo "LATEST_BACKUP=$LATEST"
echo "BACKUP_AGE_SECONDS=$BACKUP_AGE"
echo "RESTORE_CHECK_AGE_SECONDS=$VERIFY_AGE"
