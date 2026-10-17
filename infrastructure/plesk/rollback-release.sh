#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=/var/www/vhosts/euroteranga.com
RELEASES="$APP_ROOT/releases"
CURRENT="$APP_ROOT/current"
SERVICES=(web booking client tracking ops crew api)
[ "$(id -u)" -eq 0 ] || { echo "Must run as root" >&2; exit 1; }
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  [ -f "$APP_ROOT/.deploy/previous-sha" ] || { echo "No previous SHA recorded" >&2; exit 1; }
  TARGET="$(cat "$APP_ROOT/.deploy/previous-sha")"
fi
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid SHA" >&2; exit 2; }
TARGET_DIR="$RELEASES/$TARGET"
[ -d "$TARGET_DIR" ] || { echo "Release not found: $TARGET" >&2; exit 1; }
CURRENT_DIR="$(readlink -f "$CURRENT" 2>/dev/null || true)"
LINK="$APP_ROOT/.current.rollback.$$"
ln -s "$TARGET_DIR" "$LINK"
mv -Tf "$LINK" "$CURRENT"
for service in "${SERVICES[@]}"; do systemctl restart "euroteranga-${service}.service"; done
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3206/health/ready |
  grep -q '"status":"ok"'
for port in 3200 3201 3202 3203 3204 3205; do
  curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${port}/" >/dev/null
done
[ -z "$CURRENT_DIR" ] || basename "$CURRENT_DIR" >"$APP_ROOT/.deploy/previous-sha"
echo "ROLLED_BACK_TO=$TARGET"
echo "Database schema was not changed by this rollback"
