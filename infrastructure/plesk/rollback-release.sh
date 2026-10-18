#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=/var/www/vhosts/euroteranga.com
RELEASES="$APP_ROOT/releases"
CURRENT="$APP_ROOT/current"
SERVICES=(web booking client tracking ops crew api)
# shellcheck source=lib/readiness.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/readiness.sh"
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
wait_until_ready "release ${TARGET:0:12}" || { echo "Rolled-back release is not ready" >&2; exit 1; }
[ -z "$CURRENT_DIR" ] || basename "$CURRENT_DIR" >"$APP_ROOT/.deploy/previous-sha"
echo "ROLLED_BACK_TO=$TARGET"
echo "Database schema was not changed by this rollback"
