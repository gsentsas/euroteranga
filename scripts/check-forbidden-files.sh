#!/usr/bin/env bash
# Repository hygiene gate (CI "security" job and release builds).
#  1. No tracked file that must never be committed (env files, keys, dumps...).
#  2. No quality-gate bypass markers on critical paths.
#  3. Authentication and Crew-offline hygiene.
#
# It works in a Git checkout (CI) and in an immutable release tree extracted
# with `git archive` (no .git, see infrastructure/plesk/deploy-release.sh).
# A search that cannot run is an error, never "nothing found".
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  mode=git
else
  mode=tree
fi
status=0

# Candidate files, NUL-separated and relative to the root. In a release tree,
# installed or generated directories are not repository content.
list_files() {
  if [[ "$mode" == git ]]; then
    git ls-files -z
    return
  fi
  find . \( -name node_modules -o -name .next -o -name dist -o -name .turbo -o -name coverage \
    -o -name test-results -o -name playwright-report -o -name .pnpm-store \) -prune \
    -o -type f -print0 | sed -z 's#^\./##'
}

# Git pathspec glob -> bash pattern ("*" also matches "/" in [[ == ]]).
to_pattern() {
  local glob="${1//\*\*\//}"
  printf '%s' "${glob//\*\*/*}"
}

# search PATTERN INCLUDES EXCLUDES (names of arrays of git pathspec globs).
# Prints path:line:text; returns 0 when something matched, 1 when nothing
# matched and 2 when the search itself failed.
search() {
  local pattern="$1"
  local -n includes="$2" excludes="$3"
  if [[ "$mode" == git ]]; then
    local specs=() glob
    for glob in "${includes[@]}"; do specs+=("$glob"); done
    for glob in "${excludes[@]}"; do specs+=(":!$glob"); done
    local rc=0
    git grep -nE "$pattern" -- "${specs[@]}" || rc=$?
    return "$rc"
  fi
  local file glob found=1 included rc include_patterns=() exclude_patterns=()
  for glob in "${includes[@]}"; do include_patterns+=("$(to_pattern "$glob")"); done
  for glob in "${excludes[@]}"; do exclude_patterns+=("$(to_pattern "$glob")"); done
  while IFS= read -r -d '' file; do
    included=$(( ${#include_patterns[@]} == 0 ))
    for glob in "${include_patterns[@]}"; do
      [[ "$file" == $glob ]] && included=1 && break
    done
    (( included )) || continue
    for glob in "${exclude_patterns[@]}"; do
      [[ "$file" == $glob ]] && continue 2
    done
    rc=0
    grep -nHE -- "$pattern" "$file" || rc=$?
    if (( rc == 0 )); then found=0; elif (( rc > 1 )); then return 2; fi
  done < <(list_files)
  return "$found"
}

# report LABEL PATTERN INCLUDES EXCLUDES
report() {
  local label="$1" matches rc=0
  matches="$(search "$2" "$3" "$4")" || rc=$?
  if (( rc == 0 )); then
    while IFS= read -r line; do echo "::error::$label: $line"; done <<<"$matches"
    status=1
  elif (( rc > 1 )); then
    echo "::error::$label: the search could not run (mode $mode)"
    status=1
  fi
}

file_count=0
while IFS= read -r -d '' file; do
  file_count=$((file_count + 1))
  base="$(basename "$file")"
  case "$base" in
    .env.example) continue ;;
    .env | .env.* | *.pem | *.key | *.p12 | *.pfx | *.crt | *.csr | id_rsa* | id_ed25519* | \
      *.dump | *.sql.gz | *.backup | *.sqlite | *.sqlite3)
      echo "::error file=$file::Forbidden file is tracked: $file"
      status=1
      ;;
  esac
  case "/$file" in
    */backups/* | */dumps/* | */uploads/* | */private/*)
      echo "::error file=$file::Forbidden directory content is tracked: $file"
      status=1
      ;;
  esac
done < <(list_files)
if (( file_count == 0 )); then
  echo "::error::No repository file found (mode $mode): the check cannot run"
  exit 1
fi

# Markers that would let CI pass while hiding a problem. This script, its
# self-test and the contributing guide mention them on purpose.
all=()
bypass_exclusions=('scripts/check-forbidden-files.sh' 'scripts/test-check-forbidden-files.sh' 'CONTRIBUTING.md' 'docs/**')
report 'Quality-gate bypass marker' \
  'continue-on-error:[[:space:]]*true|TEMP_BYPASS|TODO_SECURITY|FIXME_SECURITY|\b(it|test|describe)\.(only|skip)\(' \
  all bypass_exclusions

# Authentication and Crew-offline hygiene (PR-02 / PR-18):
# - browser code never persists secrets in web storage (sessions are HttpOnly cookies);
# - the sole IndexedDB adapter is the reviewed, minimized Crew offline store;
# - the API never uses Math.random (not a CSPRNG) nor console.log (unredacted output).
browser_code=('apps/*/app/**' 'apps/*/components/**' 'apps/*/lib/**' 'packages/auth-client/src/**' 'packages/ui/src/**')
browser_exclusions=('apps/crew/lib/offline-store.ts' '**/*.test.ts')
report 'Browser storage used in application code' \
  '\b(localStorage|sessionStorage|indexedDB)[[:space:]]*[.[]' browser_code browser_exclusions
crew_offline=('apps/crew/lib/offline-*.ts')
none=()
report 'Forbidden secret or passenger field in Crew offline records' \
  '\b(password|cookie|csrf|accessToken|refreshToken|sessionToken|documentNumber|dateOfBirth)[[:space:]]*:' \
  crew_offline none
api_code=('apps/api/src/**')
report 'Insecure randomness or raw console output in the API' \
  '\bMath\.random\(|\bconsole\.(log|info|debug)\(' api_code none

if [[ "$status" -eq 0 ]]; then
  echo "Forbidden files, bypass markers and auth hygiene: none found (${file_count} files, ${mode} mode)."
fi
exit "$status"
