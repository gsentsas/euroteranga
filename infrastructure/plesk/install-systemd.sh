#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Must run as root" >&2; exit 1; }
SOURCE="${1:-$(pwd)/infrastructure/plesk/systemd}"
[ -d "$SOURCE" ] || { echo "Missing systemd source: $SOURCE" >&2; exit 1; }
for unit in "$SOURCE"/euroteranga-*.service "$SOURCE"/euroteranga-*.timer; do
  [ -e "$unit" ] || continue
  install -m 0644 -o root -g root "$unit" "/etc/systemd/system/$(basename "$unit")"
done
systemctl daemon-reload
systemctl enable euroteranga-web.service euroteranga-booking.service \
  euroteranga-client.service euroteranga-tracking.service euroteranga-ops.service \
  euroteranga-crew.service euroteranga-api.service
systemctl enable --now euroteranga-auth-purge.timer
echo "EURO TERANGA runtime units installed/enabled; auth purge timer started."
