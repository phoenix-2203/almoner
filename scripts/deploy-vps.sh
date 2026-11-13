#!/usr/bin/env bash
# Publish the static site (web/) to a VPS that runs Caddy.
#   bash scripts/deploy-vps.sh root@203.0.113.5 almoner.example.org
# First run: adds a site block to /etc/caddy/Caddyfile (a backup is kept) and reloads Caddy,
# which fetches the HTTPS certificate by itself. Later runs only upload the files.
set -euo pipefail
HOST="${1:?usage: deploy-vps.sh user@host domain}"
DOMAIN="${2:?usage: deploy-vps.sh user@host domain}"
cd "$(dirname "$0")/.."
[ -f web/index.html ] || { echo "web/index.html not found"; exit 1; }

echo "Uploading web/ to $HOST:/var/www/almoner ..."
tar -C web -czf - . | ssh "$HOST" '
  set -e
  SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
  $SUDO mkdir -p /var/www/almoner
  $SUDO tar -xzf - -C /var/www/almoner
  $SUDO chmod -R a+rX /var/www/almoner
'

echo "Checking Caddy ..."
ssh "$HOST" "DOMAIN='$DOMAIN' bash -s" <<'REMOTE'
set -e
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
CF=/etc/caddy/Caddyfile
[ -f "$CF" ] || { echo "No $CF on this server. Is Caddy installed as a system service?"; exit 1; }
if $SUDO grep -q "^$DOMAIN" "$CF"; then
  echo "Caddy already serves $DOMAIN; files updated."
  exit 0
fi
$SUDO cp "$CF" "$CF.bak-almoner"
printf '\n%s {\n\troot * /var/www/almoner\n\tencode gzip\n\tfile_server\n}\n' "$DOMAIN" | $SUDO tee -a "$CF" >/dev/null
if $SUDO caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1; then
  $SUDO systemctl reload caddy
  echo "Added $DOMAIN to Caddy and reloaded it."
else
  $SUDO cp "$CF.bak-almoner" "$CF"
  echo "Caddy rejected the new settings, so the old Caddyfile was restored. Nothing changed."
  exit 1
fi
REMOTE
echo "Done: https://$DOMAIN/  (the first visit can take up to a minute while Caddy gets the certificate)"
