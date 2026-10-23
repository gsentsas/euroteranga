# shellcheck shell=bash
# Readiness of the EURO TERANGA services after a (re)start, shared by
# deploy-release.sh and rollback-release.sh (OPS-DEPLOY-1).
#
# Every endpoint is polled quietly (no "curl: (7)" noise while a service is
# still starting), each one is logged once when it becomes ready, a unit that
# enters the failed state stops the wait at once, and the whole wait is
# bounded by READY_TIMEOUT_SECONDS. On failure the endpoints that never became
# ready are listed with their last observation.

READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-90}"
READY_POLL_SECONDS="${READY_POLL_SECONDS:-1}"
# name|url|check ("json" = body must report {"status":"ok"}, "http" = 2xx/3xx).
READINESS_ENDPOINTS="${READINESS_ENDPOINTS:-api|http://127.0.0.1:3206/health/ready|json
web|http://127.0.0.1:3200/|http
booking|http://127.0.0.1:3201/|http
client|http://127.0.0.1:3202/|http
tracking|http://127.0.0.1:3203/|http
ops|http://127.0.0.1:3204/|http
crew|http://127.0.0.1:3205/|http}"
# systemd units watched for an early failure (empty: no unit check).
READINESS_UNITS="${READINESS_UNITS-euroteranga-api euroteranga-web euroteranga-booking euroteranga-client euroteranga-tracking euroteranga-ops euroteranga-crew}"

# probe URL CHECK -> prints "ok" or a short observation; never prints curl errors.
readiness_probe() {
  local url="$1" check="$2" body code rc=0
  if [ "$check" = json ]; then
    body="$(curl --silent --max-time 2 "$url")" || rc=$?
    if [ "$rc" -ne 0 ]; then echo "no answer (curl exit $rc)"; return; fi
    if printf '%s' "$body" | grep -q '"status":"ok"'; then echo ok; else echo "not ready"; fi
    return
  fi
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 "$url")" || rc=$?
  if [ "$rc" -ne 0 ] && [ "$code" = 000 ]; then echo "no answer (curl exit $rc)"; return; fi
  case "$code" in
    2?? | 3??) echo ok ;;
    *) echo "HTTP $code" ;;
  esac
}

# wait_until_ready [label] -> 0 when every endpoint is ready, 1 otherwise.
wait_until_ready() {
  local label="${1:-services}" started now elapsed line name url check unit observation
  local -A ready=() last=()
  local total=0 count=0
  started="$(date +%s)"
  while IFS='|' read -r name url check; do
    [ -n "$name" ] || continue
    total=$((total + 1))
  done <<<"$READINESS_ENDPOINTS"
  echo "Waiting for ${label} (${total} endpoints, up to ${READY_TIMEOUT_SECONDS}s)"
  while :; do
    while IFS='|' read -r name url check; do
      [ -n "$name" ] || continue
      [ -n "${ready[$name]:-}" ] && continue
      observation="$(readiness_probe "$url" "$check")"
      if [ "$observation" = ok ]; then
        ready[$name]=1
        count=$((count + 1))
        echo "  ready: ${name} after $(( $(date +%s) - started ))s"
      else
        last[$name]="$observation"
      fi
    done <<<"$READINESS_ENDPOINTS"
    if [ "$count" -eq "$total" ]; then
      echo "All ${label} ready after $(( $(date +%s) - started ))s"
      return 0
    fi
    for unit in $READINESS_UNITS; do
      if systemctl is-failed --quiet "${unit}.service"; then
        echo "Unit ${unit}.service failed while starting:" >&2
        systemctl status "${unit}.service" --no-pager --lines=20 >&2 || true
        return 1
      fi
    done
    now="$(date +%s)"
    elapsed=$((now - started))
    if [ "$elapsed" -ge "$READY_TIMEOUT_SECONDS" ]; then
      echo "${label} not ready after ${elapsed}s:" >&2
      while IFS='|' read -r name url check; do
        [ -n "$name" ] || continue
        [ -n "${ready[$name]:-}" ] || echo "  ${name} (${url}): ${last[$name]:-not probed}" >&2
      done <<<"$READINESS_ENDPOINTS"
      return 1
    fi
    sleep "$READY_POLL_SECONDS"
  done
}
