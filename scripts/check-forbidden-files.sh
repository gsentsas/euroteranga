#!/usr/bin/env bash
# Repository hygiene gate (CI "security" job).
#  1. No tracked file that must never be committed (env files, keys, dumps...).
#  2. No quality-gate bypass markers on critical paths.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
status=0

while IFS= read -r -d '' file; do
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
done < <(git ls-files -z)

# Markers that would let CI pass while hiding a problem. This script and the
# contributing guide mention them on purpose and are excluded.
bypass_pattern='continue-on-error:[[:space:]]*true|TEMP_BYPASS|TODO_SECURITY|FIXME_SECURITY|\b(it|test|describe)\.(only|skip)\('
if matches="$(git grep -nE "$bypass_pattern" -- ':!scripts/check-forbidden-files.sh' ':!CONTRIBUTING.md' ':!docs/**')"; then
  echo "$matches" | while IFS= read -r line; do echo "::error::Quality-gate bypass marker: $line"; done
  status=1
fi

# Authentication and Crew-offline hygiene (PR-02 / PR-18):
# - browser code never persists secrets in web storage (sessions are HttpOnly cookies);
# - the sole IndexedDB adapter is the reviewed, minimized Crew offline store;
# - the API never uses Math.random (not a CSPRNG) nor console.log (unredacted output).
storage_pattern='\b(localStorage|sessionStorage|indexedDB)[[:space:]]*[.[]'
if matches="$(git grep -nE "$storage_pattern" -- 'apps/*/app/**' 'apps/*/components/**' 'apps/*/lib/**' 'packages/auth-client/src/**' 'packages/ui/src/**' ':!apps/crew/lib/offline-store.ts' ':!**/*.test.ts')"; then
  echo "$matches" | while IFS= read -r line; do echo "::error::Browser storage used in application code: $line"; done
  status=1
fi
crew_secret_field_pattern='\b(password|cookie|csrf|accessToken|refreshToken|sessionToken|documentNumber|dateOfBirth)[[:space:]]*:'
if matches="$(git grep -nE "$crew_secret_field_pattern" -- 'apps/crew/lib/offline-*.ts')"; then
  echo "$matches" | while IFS= read -r line; do echo "::error::Forbidden secret or passenger field in Crew offline records: $line"; done
  status=1
fi
if matches="$(git grep -nE '\bMath\.random\(|\bconsole\.(log|info|debug)\(' -- 'apps/api/src/**')"; then
  echo "$matches" | while IFS= read -r line; do echo "::error::Insecure randomness or raw console output in the API: $line"; done
  status=1
fi

if [[ "$status" -eq 0 ]]; then
  echo "Forbidden files, bypass markers and auth hygiene: none found."
fi
exit "$status"
