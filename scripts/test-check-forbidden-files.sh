#!/usr/bin/env bash
# Self-test of scripts/check-forbidden-files.sh (CI "security" job): it must
# pass on the repository, behave identically in a release tree without .git,
# ignore installed and generated directories, detect each violation, and fail
# (never pass silently) when a search cannot run.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'chmod -R u+rw "$work" 2>/dev/null; rm -rf "$work"' EXIT
failures=0

expect() {
  local name="$1" expected="$2" needle="$3" dir="$4" output rc=0
  output="$(bash "$dir/scripts/check-forbidden-files.sh" 2>&1)" || rc=$?
  if [[ "$rc" -ne "$expected" ]] || ! grep -qF -- "$needle" <<<"$output" || grep -q 'fatal:' <<<"$output"; then
    echo "FAIL: $name (exit $rc, expected $expected, wanted \"$needle\")"
    echo "$output" | sed 's/^/    /'
    failures=$((failures + 1))
  else
    echo "ok: $name"
  fi
}

# A release-like tree: the repository files, no .git (as extracted by git archive).
fresh_tree() {
  local dir="$work/$1"
  mkdir -p "$dir"
  (cd "$root" && git ls-files -z | xargs -0 cp --parents -t "$dir")
  printf '%s\n' "$dir"
}

expect 'git checkout passes' 0 'git mode' "$root"

tree="$(fresh_tree clean)"
mkdir -p "$tree/node_modules/pkg" "$tree/apps/web/.next" "$tree/apps/api/dist"
echo 'SECRET=x' >"$tree/node_modules/pkg/.env"
echo 'key' >"$tree/apps/web/.next/server.pem"
echo 'console.log(1)' >"$tree/apps/api/dist/main.js"
expect 'release tree passes and ignores installed or generated files' 0 'tree mode' "$tree"

tree="$(fresh_tree env)"
echo 'SECRET=x' >"$tree/.env"
expect 'release tree: tracked env file' 1 'Forbidden file is tracked: .env' "$tree"

tree="$(fresh_tree dump)"
mkdir -p "$tree/backups" && echo x >"$tree/backups/db.dump"
expect 'release tree: database dump' 1 'backups/db.dump' "$tree"

tree="$(fresh_tree bypass)"
echo "it.only('x', () => {});" >"$tree/apps/api/test/bypass.spec.ts"
expect 'release tree: focused test' 1 'Quality-gate bypass marker: apps/api/test/bypass.spec.ts' "$tree"

tree="$(fresh_tree storage)"
echo "localStorage.setItem('token', 'x');" >"$tree/apps/web/app/storage.tsx"
expect 'release tree: web storage in browser code' 1 'Browser storage used in application code: apps/web/app/storage.tsx' "$tree"

tree="$(fresh_tree console)"
echo "console.log('secret');" >"$tree/apps/api/src/leak.ts"
expect 'release tree: raw console in the API' 1 'raw console output in the API: apps/api/src/leak.ts' "$tree"

if [[ "$(id -u)" -ne 0 ]]; then
  tree="$(fresh_tree unreadable)"
  chmod 000 "$tree/apps/api/src/main.ts"
  expect 'release tree: a search that cannot run fails the check' 1 'the search could not run' "$tree"
fi

if [[ "$failures" -ne 0 ]]; then
  echo "$failures check-forbidden-files self-test(s) failed"
  exit 1
fi
echo "check-forbidden-files self-test: all cases passed"
