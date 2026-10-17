#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=/var/www/vhosts/euroteranga.com
STACK_DIR="$APP_ROOT/infrastructure/plesk/documents"
COMPOSE_FILE="$STACK_DIR/docker-compose.yml"

[ "$(id -u)" -eq 0 ] || { echo "Must run as root" >&2; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "Missing $COMPOSE_FILE" >&2; exit 1; }

docker compose -f "$COMPOSE_FILE" pull clamav
docker compose -f "$COMPOSE_FILE" up -d clamav

for attempt in $(seq 1 90); do
  status="$(docker inspect euroteranga-clamav --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  if [ "$status" = "healthy" ]; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    echo "ClamAV did not become healthy" >&2
    docker logs --tail 200 euroteranga-clamav >&2 || true
    exit 1
  fi
  sleep 2
done

ss -ltn 'sport = :3310' | grep -q '127.0.0.1:3310' || {
  echo "ClamAV is not bound to loopback only" >&2
  exit 1
}

python3 "$STACK_DIR/verify-clamav-instream.py"
echo "CLAMAV_PRIVATE_SCANNER=READY"
