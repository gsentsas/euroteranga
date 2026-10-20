#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=/var/www/vhosts/euroteranga.com
APP_USER=euroteranga.com_5p804yhows7
MIRROR="$APP_ROOT/.deploy/repo.git"
RELEASES="$APP_ROOT/releases"
CURRENT="$APP_ROOT/current"
API_ENV="$APP_ROOT/.secrets/api.env"
PUBLIC_ENV="$APP_ROOT/.secrets/public.env"
BACKUPS="$APP_ROOT/backups"
GIT_URL="${EUROTERANGA_GIT_URL:-https://github.com/gsentsas/euroteranga.git}"
NODE_PATH=/opt/plesk/node/24/bin:/usr/local/bin:/usr/bin:/bin
KEEP_RELEASES="${KEEP_RELEASES:-4}"
SERVICES=(web booking client tracking ops crew api)

usage() { echo "Usage: deploy-release.sh <40-char-main-commit-sha>" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "Must run as root" >&2; exit 1; }
[ "$#" -eq 1 ] || usage
SHA="$1"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || usage
[ -f "$API_ENV" ] && [ -f "$PUBLIC_ENV" ] || { echo "Pilot env missing" >&2; exit 1; }

set -a
. "$API_ENV"
. "$PUBLIC_ENV"
set +a
# APP_ENV=staging, PAYMENT_PROVIDER=DISABLED, Stripe DISABLED without credentials.
. "$(dirname "${BASH_SOURCE[0]}")/pilot-env-guard.sh"
pilot_env_guard || exit 1

install -d -m 0750 -o "$APP_USER" -g psacln "$APP_ROOT/.deploy" "$RELEASES"
install -d -m 0700 -o "$APP_USER" -g psacln "$BACKUPS"
if [ ! -d "$MIRROR" ]; then
  runuser -u "$APP_USER" -- env HOME="$APP_ROOT" PATH="$NODE_PATH" \
    git clone --mirror "$GIT_URL" "$MIRROR"
fi
runuser -u "$APP_USER" -- env HOME="$APP_ROOT" PATH="$NODE_PATH" \
  git --git-dir="$MIRROR" fetch --prune origin '+refs/heads/main:refs/heads/main'
RESOLVED="$(runuser -u "$APP_USER" -- git --git-dir="$MIRROR" rev-parse "$SHA^{commit}")"
[ "$RESOLVED" = "$SHA" ] || { echo "Commit resolution mismatch" >&2; exit 1; }
runuser -u "$APP_USER" -- git --git-dir="$MIRROR" merge-base --is-ancestor \
  "$SHA" refs/heads/main || { echo "Refusing commit outside main" >&2; exit 1; }

RELEASE="$RELEASES/$SHA"
if [ ! -d "$RELEASE" ]; then
  TMP="$RELEASES/.${SHA}.tmp.$$"
  rm -rf "$TMP"
  install -d -m 0750 -o "$APP_USER" -g psacln "$TMP"
  runuser -u "$APP_USER" -- git --git-dir="$MIRROR" archive "$SHA" |
    runuser -u "$APP_USER" -- tar -x -C "$TMP"

  foreign_owner="$(find "$TMP" -xdev ! -user "$APP_USER" -print -quit)"
  if [ -n "$foreign_owner" ]; then
    echo "Refusing release tree with foreign ownership: $foreign_owner" >&2
    rm -rf "$TMP"
    exit 1
  fi

  # git archive intentionally produces no .git directory, while the hygiene
  # gate relies on git ls-files/git grep. Reconstruct only a temporary index
  # from the archived release before dependency installation so the gate scans
  # exactly the source files that will be deployed, not node_modules/build
  # artifacts. The temporary repository is removed even when the gate fails.
  runuser -u "$APP_USER" -- env HOME="$APP_ROOT" PATH="$NODE_PATH" \
    bash -c "set -euo pipefail
cd '$TMP'
git init -q
trap 'rm -rf .git' EXIT
git add -A
pnpm check:forbidden-files
rm -rf .git
trap - EXIT"

  runuser -u "$APP_USER" -- bash -c 'printf "%s\\n" "$1" >"$2/.release-sha"' _ "$SHA" "$TMP"
  runuser -u "$APP_USER" -- env HOME="$APP_ROOT" PATH="$NODE_PATH" \
    NEXT_PUBLIC_APP_ENV="$NEXT_PUBLIC_APP_ENV" \
    NEXT_PUBLIC_API_BASE_URL="$NEXT_PUBLIC_API_BASE_URL" \
    NEXT_PUBLIC_CLIENT_URL="$NEXT_PUBLIC_CLIENT_URL" \
    bash -c "cd '$TMP' && pnpm install --frozen-lockfile --prefer-offline"
  runuser -u "$APP_USER" -- env HOME="$APP_ROOT" PATH="$NODE_PATH" \
    NEXT_PUBLIC_APP_ENV="$NEXT_PUBLIC_APP_ENV" \
    NEXT_PUBLIC_API_BASE_URL="$NEXT_PUBLIC_API_BASE_URL" \
    NEXT_PUBLIC_CLIENT_URL="$NEXT_PUBLIC_CLIENT_URL" \
    bash -c "cd '$TMP' && pnpm build"
  mv "$TMP" "$RELEASE"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$BACKUPS/pre-${SHA}-${STAMP}.dump"
runuser -u "$APP_USER" -- pg_dump "$DATABASE_URL" --format=custom --file="$BACKUP"
chmod 0600 "$BACKUP"
runuser -u "$APP_USER" -- env HOME="$APP_ROOT" PATH="$NODE_PATH" DATABASE_URL="$DATABASE_URL" \
  bash -c "cd '$RELEASE' && pnpm db:validate && pnpm db:migrate"

PREVIOUS=""
[ ! -L "$CURRENT" ] || PREVIOUS="$(readlink -f "$CURRENT")"
NEW_LINK="$APP_ROOT/.current.$$"
ln -s "$RELEASE" "$NEW_LINK"
mv -Tf "$NEW_LINK" "$CURRENT"
[ -z "$PREVIOUS" ] || basename "$PREVIOUS" >"$APP_ROOT/.deploy/previous-sha"

restart_all() {
  for service in "${SERVICES[@]}"; do systemctl restart "euroteranga-${service}.service"; done
}
verify_loopback_once() {
  curl --fail --silent --show-error --max-time 2 http://127.0.0.1:3206/health/ready |
    grep -q '"status":"ok"'
  for port in 3200 3201 3202 3203 3204 3205; do
    curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/" >/dev/null
  done
}

wait_for_loopback() {
  local attempt
  for attempt in $(seq 1 30); do
    if verify_loopback_once; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_all
if ! wait_for_loopback; then
  echo "New release failed loopback health checks" >&2
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    ROLLBACK_LINK="$APP_ROOT/.current.rollback.$$"
    ln -s "$PREVIOUS" "$ROLLBACK_LINK"
    mv -Tf "$ROLLBACK_LINK" "$CURRENT"
    restart_all
    echo "Application symlink restored to $(basename "$PREVIOUS")" >&2
    echo "Database migrations were not rolled back automatically" >&2
  fi
  exit 1
fi

echo "$SHA" >"$APP_ROOT/.deploy/last-successful-sha"
mapfile -t OLD_RELEASES < <(
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
    sort -nr | awk -v keep="$KEEP_RELEASES" 'NR > keep {print $2}'
)
for old in "${OLD_RELEASES[@]}"; do
  [ "$old" = "$(readlink -f "$CURRENT")" ] && continue
  [ -z "$PREVIOUS" ] || [ "$old" != "$PREVIOUS" ] || continue
  rm -rf -- "$old"
done
echo "DEPLOYED_SHA=$SHA"
echo "PRE_MIGRATION_BACKUP=$BACKUP"
