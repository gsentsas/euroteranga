#!/usr/bin/env bash
# Self-test of infrastructure/plesk/lib/readiness.sh (CI "security" job), with
# local HTTP servers standing in for the services: late starters are waited
# for without curl noise, a service that never answers fails within the
# timeout, and an API answering without {"status":"ok"} is not ready.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT
failures=0

port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }

# serve PORT DELAY BODY: an HTTP server that starts after DELAY seconds.
serve() {
  local dir="$work/$1"
  mkdir -p "$dir/health"
  printf '%s' "$3" >"$dir/health/ready"
  printf 'ok' >"$dir/index.html"
  (sleep "$2" && exec python3 -m http.server "$1" --bind 127.0.0.1 --directory "$dir") >/dev/null 2>&1 &
  pids+=("$!")
}

check() {
  local name="$1" expected="$2" needle="$3" output rc=0
  output="$(
    READINESS_UNITS='' READY_POLL_SECONDS=0.2 bash -c ". '$here/lib/readiness.sh'; wait_until_ready test" 2>&1
  )" || rc=$?
  if [ "$rc" -ne "$expected" ] || ! grep -qF -- "$needle" <<<"$output" || grep -q 'curl:' <<<"$output"; then
    echo "FAIL: $name (exit $rc, expected $expected, wanted \"$needle\")"
    echo "$output" | sed 's/^/    /'
    failures=$((failures + 1))
  else
    echo "ok: $name"
  fi
}

api="$(port)"; web="$(port)"
serve "$api" 1 '{"status":"ok"}'
serve "$web" 2 ''
export READINESS_ENDPOINTS="api|http://127.0.0.1:$api/health/ready|json
web|http://127.0.0.1:$web/|http"
export READY_TIMEOUT_SECONDS=15
check 'late services are waited for, quietly' 0 'All test ready'

never="$(port)"
export READINESS_ENDPOINTS="api|http://127.0.0.1:$api/health/ready|json
never|http://127.0.0.1:$never/|http"
export READY_TIMEOUT_SECONDS=2
check 'a service that never answers fails within the timeout' 1 "never (http://127.0.0.1:$never/): no answer (curl exit 7)"

sick="$(port)"
serve "$sick" 0 '{"status":"error"}'
export READINESS_ENDPOINTS="api|http://127.0.0.1:$sick/health/ready|json"
export READY_TIMEOUT_SECONDS=2
check 'an API that is not ready fails' 1 'api (http://127.0.0.1:'"$sick"'/health/ready): not ready'

if [ "$failures" -ne 0 ]; then
  echo "$failures readiness self-test(s) failed"
  exit 1
fi
echo "readiness self-test: all cases passed"
