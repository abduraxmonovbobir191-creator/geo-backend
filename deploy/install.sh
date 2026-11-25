#!/usr/bin/env bash
# One-time server setup for Nex Map on Ubuntu/Debian. Run as root from the deploy/ folder:
#   bash install.sh
# Safe to run again: it keeps an existing .env and data.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash install.sh" >&2
  exit 1
fi

echo "==> Installing Docker (if missing)"
if ! command -v docker >/dev/null 2>&1; then
  # Docker's official install script.
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null

echo "==> Firewall: allow SSH, HTTP and HTTPS"
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443 >/dev/null
  ufw --force enable >/dev/null
fi

echo "==> Settings (.env)"
if [ ! -f .env ]; then
  cp .env.example .env
  for name in POSTGRES_PASSWORD JWT_SECRET NOMINATIM_PASSWORD; do
    sed -i "s#^${name}=.*#${name}=$(openssl rand -hex 32)#" .env
  done
  echo "    Created .env with new random secrets."
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a
mkdir -p "$DATA_DIR"/{postgres,nominatim,tiles,caddy} "$TILE_CACHE_DIR" "$BACKUP_DIR"

echo "==> Map fonts and icons (Protomaps basemaps-assets)"
if [ ! -d tileserver/fonts ] || [ ! -d tileserver/styles/sprites ]; then
  tmp=$(mktemp -d)
  git clone --depth 1 https://github.com/protomaps/basemaps-assets "$tmp/assets"
  rm -rf tileserver/fonts tileserver/styles/sprites
  cp -r "$tmp/assets/fonts" tileserver/fonts
  mkdir -p tileserver/styles/sprites
  cp "$tmp"/assets/sprites/v4/{light,dark}{.json,.png,@2x.json,@2x.png} tileserver/styles/sprites/
  rm -rf "$tmp"
fi

echo "==> Starting API, database, address search and website"
docker compose up -d --build

cat <<EOF

Done. Check in a minute:
  https://api.${DOMAIN}/health   -> {"ok":true}
  https://api.${DOMAIN}/docs     -> API documentation
  https://${DOMAIN}              -> website

Address search for your region is importing in the background (docker compose logs -f nominatim).
Until it finishes, search uses the public OpenStreetMap server.

Next: download the map, for a quick start just Uzbekistan:
  bash download-map.sh uzbekistan
or the whole world (~120 GB, a few hours):
  bash download-map.sh world
EOF
