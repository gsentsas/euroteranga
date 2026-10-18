#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
CONTAINER_NAME="euroteranga-clamav"

[ "$(id -u)" -eq 0 ] || { echo "Must run as root" >&2; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "Missing $COMPOSE_FILE" >&2; exit 1; }

docker compose -f "$COMPOSE_FILE" pull clamav
docker compose -f "$COMPOSE_FILE" up -d clamav

for attempt in $(seq 1 90); do
  status="$(docker inspect "$CONTAINER_NAME" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  if [ "$status" = "healthy" ]; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    echo "ClamAV did not become healthy" >&2
    docker logs --tail 200 "$CONTAINER_NAME" >&2 || true
    exit 1
  fi
  sleep 2
done

binding="$(docker inspect "$CONTAINER_NAME" --format '{{with (index .NetworkSettings.Ports "3310/tcp")}}{{(index . 0).HostIp}}:{{(index . 0).HostPort}}{{end}}')"
[ "$binding" = "127.0.0.1:3310" ] || {
  echo "ClamAV runtime bind is not exactly 127.0.0.1:3310 (got: ${binding:-none})" >&2
  exit 1
}

ss -ltn 'sport = :3310' | grep -Fq '127.0.0.1:3310' || {
  echo "ClamAV loopback listener is not visible on the host" >&2
  exit 1
}

python3 "$SCRIPT_DIR/verify-clamav-instream.py"
echo "CLAMAV_PRIVATE_SCANNER=READY"
