#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Must run as root" >&2; exit 1; }
SOURCE="${1:-$(pwd)/infrastructure/plesk/nginx}"
[ -d "$SOURCE" ] || { echo "Missing nginx source: $SOURCE" >&2; exit 1; }
HOSTS=(euroteranga.com booking.euroteranga.com client.euroteranga.com \
  tracking.euroteranga.com ops.euroteranga.com crew.euroteranga.com api.euroteranga.com)

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3206/health/ready |
  grep -q '"status":"ok"'
for port in 3200 3201 3202 3203 3204 3205; do
  curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${port}/" >/dev/null
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="/var/www/vhosts/euroteranga.com/.deploy/nginx-$STAMP"
mkdir -p "$BACKUP_ROOT"
restore() {
  set +e
  for host in "${HOSTS[@]}"; do
    dst="/var/www/vhosts/system/$host/conf/vhost_nginx.conf"
    if [ -f "$BACKUP_ROOT/$host.conf" ]; then cp -a "$BACKUP_ROOT/$host.conf" "$dst"; else rm -f "$dst"; fi
    plesk bin domain --update "$host" -nginx-proxy-mode true >/dev/null 2>&1
    plesk sbin httpdmng --reconfigure-domain "$host" >/dev/null 2>&1
  done
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
}
trap 'echo "Proxy cutover failed; restoring previous Plesk proxy mode" >&2; restore' ERR

for host in "${HOSTS[@]}"; do
  src="$SOURCE/$host.conf"
  dst="/var/www/vhosts/system/$host/conf/vhost_nginx.conf"
  [ -f "$src" ] || { echo "Missing $src" >&2; exit 1; }
  [ ! -f "$dst" ] || cp -a "$dst" "$BACKUP_ROOT/$host.conf"
  install -m 0644 -o root -g root "$src" "$dst"
  plesk bin domain --update "$host" -nginx-proxy-mode false >/dev/null
  plesk sbin httpdmng --reconfigure-domain "$host" >/dev/null
done

nginx -t
systemctl reload nginx
for url in https://euroteranga.com/ https://booking.euroteranga.com/ \
  https://client.euroteranga.com/ https://tracking.euroteranga.com/ \
  https://ops.euroteranga.com/ https://crew.euroteranga.com/ \
  https://api.euroteranga.com/health/ready; do
  curl --fail --silent --show-error --location --max-time 15 "$url" >/dev/null
done
trap - ERR
echo "PUBLIC_CUTOVER=SUCCESS"
echo "NGINX_BACKUP=$BACKUP_ROOT"
