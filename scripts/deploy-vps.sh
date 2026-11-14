#!/usr/bin/env bash
# Publish the static site (web/) to a VPS that runs Caddy, and, once `npm run shop:setup`
# has been run, the demo sellers' server behind the "Be the agent" part of the Try it page.
#   bash scripts/deploy-vps.sh root@203.0.113.5 almoner.example.org
# First run: adds a site block to /etc/caddy/Caddyfile (a backup is kept) and reloads Caddy,
# which fetches the HTTPS certificate by itself. Later runs only upload the files.
# The server receives the two demo sellers' testnet keys only, never the owner's.
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

# ---- demo sellers' server (quotes and deliveries for "Be the agent") ----
BOOK=ts/.almoner/sellers.json
if [ -f "$BOOK" ]; then
  echo "Building the sellers' server ..."
  (cd ts && npm run -s build:shop >/dev/null)
  echo "Installing it on $HOST ..."
  ssh "$HOST" 'set -e; SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"; $SUDO mkdir -p /opt/almoner /etc/almoner; $SUDO chmod 755 /opt/almoner'
  ssh "$HOST" 'SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"; $SUDO tee /opt/almoner/shop-server.mjs >/dev/null' < ts/dist/shop-server.mjs
  ssh "$HOST" 'SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"; umask 077; $SUDO tee /etc/almoner/sellers.json >/dev/null' < "$BOOK"
  ssh "$HOST" "DOMAIN='$DOMAIN' PORT='${SHOP_PORT:-8791}' bash -s" <<'REMOTE'
set -e
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }
if [ -z "$(major)" ] || [ "$(major)" -lt 20 ]; then
  if command -v apt-get >/dev/null; then
    echo "Installing Node.js 22 (the server has $(node -v 2>/dev/null || echo none)) ..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - >/dev/null
    $SUDO apt-get install -y nodejs >/dev/null
  else
    echo "This server needs Node.js 20 or newer. Install it, then run this script again."; exit 1
  fi
fi
# Another app may already use the port. Stop ours, then take the first port nothing is listening on.
ours() { curl -fsS "http://127.0.0.1:$1/health" 2>/dev/null | grep -q '"vault"'; }
$SUDO systemctl stop almoner-shop 2>/dev/null || true
sleep 1
while ss -ltn 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"; do echo "Port $PORT is used by another app on this server; trying $((PORT + 1))."; PORT=$((PORT + 1)); done
id almoner >/dev/null 2>&1 || $SUDO useradd --system --no-create-home --shell /usr/sbin/nologin almoner
$SUDO chown almoner /etc/almoner/sellers.json && $SUDO chmod 600 /etc/almoner/sellers.json
# The AI agent on the Sandbox page needs a model key (Groq). It stays on this server.
if [ ! -s /etc/almoner/relay.env ]; then
  if [ -r /etc/acan/relay.env ] && $SUDO grep -q '^GROQ_API_KEY=' /etc/acan/relay.env; then
    $SUDO sh -c "umask 077; grep '^GROQ_API_KEY=' /etc/acan/relay.env > /etc/almoner/relay.env"
    echo "AI agent: reusing the model key already on this server."
  else
    NEED_KEY=1
  fi
fi
$SUDO tee /etc/systemd/system/almoner-shop.service >/dev/null <<UNIT
[Unit]
Description=Almoner demo sellers (quotes and deliveries for the Try it page)
After=network-online.target
Wants=network-online.target

[Service]
User=almoner
Environment=ALMONER_SELLERS_FILE=/etc/almoner/sellers.json
Environment=SELLERS_PORT=$PORT
Environment=SELLERS_HOST=127.0.0.1
Environment=NEAR_NETWORK=testnet
EnvironmentFile=-/etc/almoner/relay.env
ExecStart=$(command -v node) /opt/almoner/shop-server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
$SUDO systemctl daemon-reload
$SUDO systemctl enable -q almoner-shop
$SUDO systemctl restart almoner-shop
sleep 2
if ! ours "$PORT"; then
  echo "The sellers' server did not start. Last lines of its log:"; $SUDO journalctl -u almoner-shop -n 15 --no-pager; exit 1
fi
echo "Sellers' server is running on 127.0.0.1:$PORT."
if [ -n "${NEED_KEY:-}" ]; then
  echo
  echo "! The Sandbox page's AI agent is OFF: this server has no model key yet (the page falls back to fixed plans)."
  echo "  To turn it on, log in to the server and run this one line. It asks for a Groq API key (console.groq.com, free) and hides what you paste:"
  echo "    sudo sh -c 'umask 077; printf \"Groq key: \"; stty -echo; read k; stty echo; echo; printf \"GROQ_API_KEY=%s\\n\" \"\$k\" > /etc/almoner/relay.env; systemctl restart almoner-shop'"
  echo
fi

CF=/etc/caddy/Caddyfile
if $SUDO grep -q "almoner-shop" "$CF"; then
  if $SUDO grep -A3 "almoner-shop" "$CF" | grep -q "reverse_proxy 127.0.0.1:$PORT\$"; then
    echo "Caddy already forwards /api to it."
  else
    $SUDO cp "$CF" "$CF.bak-almoner-shop"
    $SUDO sed -i "/almoner-shop/,/}/ s#reverse_proxy 127.0.0.1:[0-9]*#reverse_proxy 127.0.0.1:$PORT#" "$CF"
    if $SUDO caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1; then $SUDO systemctl reload caddy; echo "Caddy now forwards /api to port $PORT."
    else $SUDO cp "$CF.bak-almoner-shop" "$CF"; echo "Could not update the /api rule in Caddy; the old Caddyfile was restored."; exit 1; fi
  fi
else
  $SUDO cp "$CF" "$CF.bak-almoner-shop"
  $SUDO awk -v d="$DOMAIN" -v p="$PORT" '
    { print }
    !done && index($0, d) == 1 && $0 ~ /\{[ \t]*$/ { print "\t# almoner-shop: the demo sellers for the Try it page"; print "\thandle_path /api/* {"; print "\t\treverse_proxy 127.0.0.1:" p; print "\t}"; done = 1 }
  ' "$CF.bak-almoner-shop" | $SUDO tee "$CF" >/dev/null
  if $SUDO grep -q "almoner-shop" "$CF" && $SUDO caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1; then
    $SUDO systemctl reload caddy
    echo "Caddy now forwards https://$DOMAIN/api to the sellers' server."
  else
    $SUDO cp "$CF.bak-almoner-shop" "$CF"
    echo "Could not add the /api rule to Caddy, so the old Caddyfile was restored. Send this message to whoever set up the server."
    exit 1
  fi
fi
REMOTE
  sleep 2
  if curl -fsS "https://$DOMAIN/api/health" 2>/dev/null | grep -q '"vault"'; then echo "Checked: https://$DOMAIN/api/health answers."; else echo "! https://$DOMAIN/api/health did not answer as the sellers' server. Open it in a browser: it should show JSON starting with {\"ok\":true. If it shows another site, send Claude this output."; fi
else
  echo "(No $BOOK yet: run 'npm run shop:setup' in ts/ to open the hands-on shop, then run this script again.)"
fi
echo "Done: https://$DOMAIN/  (the first visit can take up to a minute while Caddy gets the certificate)"
