#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=/var/www/vhosts/euroteranga.com
APP_USER=euroteranga.com_5p804yhows7
ENV_DIR="$APP_ROOT/.secrets"
API_ENV="$ENV_DIR/api.env"
PUBLIC_ENV="$ENV_DIR/public.env"
DB_ROLE=euroteranga_pilot
DB_NAME=euroteranga_pilot

[ "$(id -u)" -eq 0 ] || { echo "Must run as root" >&2; exit 1; }
[ ! -e "$API_ENV" ] && [ ! -e "$PUBLIC_ENV" ] || {
  echo "Refusing to overwrite existing pilot environment files" >&2
  exit 1
}
if runuser -u postgres -- psql -X -d template1 -Atqc \
  "select 1 from pg_roles where rolname='$DB_ROLE'" | grep -q '^1$'; then
  echo "Refusing: PostgreSQL role $DB_ROLE already exists" >&2
  exit 1
fi
if runuser -u postgres -- psql -X -d template1 -Atqc \
  "select 1 from pg_database where datname='$DB_NAME'" | grep -q '^1$'; then
  echo "Refusing: PostgreSQL database $DB_NAME already exists" >&2
  exit 1
fi

DB_PASSWORD="$(openssl rand -hex 32)"
AUTH_CSRF_KEY="$(openssl rand -base64 32 | tr -d '\n')"
AUTH_HMAC_KEY="$(openssl rand -base64 32 | tr -d '\n')"
AUTH_TOTP_KEY="$(openssl rand -base64 32 | tr -d '\n')"

runuser -u postgres -- psql -X -d template1 -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE $DB_ROLE LOGIN PASSWORD '$DB_PASSWORD';"
runuser -u postgres -- createdb --maintenance-db=template1 -T template0 \
  -O "$DB_ROLE" "$DB_NAME"

install -d -m 0700 -o "$APP_USER" -g psacln "$ENV_DIR"
umask 077
cat >"$API_ENV" <<EOF
NODE_ENV=production
APP_ENV=staging
DATABASE_URL=postgresql://$DB_ROLE:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME
API_HOST=127.0.0.1
API_PORT=3206
API_CORS_ORIGINS=https://euroteranga.com,https://booking.euroteranga.com,https://client.euroteranga.com,https://tracking.euroteranga.com,https://ops.euroteranga.com,https://crew.euroteranga.com
API_TRUST_PROXY=loopback
OPENAPI_ENABLED=false
LOG_LEVEL=info
AUTH_CSRF_KEY=$AUTH_CSRF_KEY
AUTH_HMAC_KEY=$AUTH_HMAC_KEY
AUTH_TOTP_ENCRYPTION_KEY=$AUTH_TOTP_KEY
AUTH_TOTP_ENCRYPTION_KEY_VERSION=1
AUTH_CUSTOMER_ORIGINS=https://client.euroteranga.com,https://booking.euroteranga.com
AUTH_STAFF_ORIGINS=https://ops.euroteranga.com
AUTH_CREW_ORIGINS=https://crew.euroteranga.com
AUTH_MAIL_PROVIDER=smtp
AUTH_EMAIL_FROM=no-reply@euroteranga.com
CLIENT_PUBLIC_URL=https://client.euroteranga.com
OPS_PUBLIC_URL=https://ops.euroteranga.com
SMTP_HOST=127.0.0.1
SMTP_PORT=25
SMTP_SECURE=false
BOOKING_HOLD_TTL_SECONDS=900
BOOKING_MAX_SEATS_PER_HOLD=8
PAYMENT_PROVIDER=DISABLED
PAYMENT_STRIPE_MODE=DISABLED
OBJECT_STORAGE_PROVIDER=DISABLED
MALWARE_SCANNER=DISABLED
PASSENGER_DOCUMENT_MAX_BYTES=10485760
EOF
cat >"$PUBLIC_ENV" <<EOF
NODE_ENV=production
NEXT_PUBLIC_APP_ENV=staging
NEXT_PUBLIC_API_BASE_URL=https://api.euroteranga.com
NEXT_PUBLIC_CLIENT_URL=https://client.euroteranga.com
EOF
chown "$APP_USER":psacln "$API_ENV" "$PUBLIC_ENV"
chmod 0600 "$API_ENV" "$PUBLIC_ENV"
echo "Pilot database and environment created; generated credentials were not printed."
