#!/usr/bin/env bash
# Downloads the map data (Protomaps daily build of OpenStreetMap) and starts the tile server.
#   bash download-map.sh uzbekistan    # about 1 GB, minutes; good for a first test
#   bash download-map.sh world         # about 120 GB, a few hours
#   bash download-map.sh 55.9,37.1,73.2,45.6   # any area: min_lon,min_lat,max_lon,max_lat
# Run it again later to update the map.
set -euo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

area="${1:-}"
case "$area" in
  world) bbox="" ;;
  uzbekistan) bbox="55.9,37.1,73.2,45.6" ;;
  central-asia) bbox="46.4,35.1,87.4,55.5" ;;
  *,*,*,*) bbox="$area" ;;
  *)
    echo "Usage: bash download-map.sh uzbekistan | central-asia | world | min_lon,min_lat,max_lon,max_lat" >&2
    exit 1
    ;;
esac

echo "==> Finding the newest Protomaps build"
url=""
for days_ago in $(seq 0 14); do
  day=$(date -u -d "-${days_ago} day" +%Y%m%d)
  if curl -fsI "https://build.protomaps.com/${day}.pmtiles" >/dev/null 2>&1; then
    url="https://build.protomaps.com/${day}.pmtiles"
    break
  fi
done
[ -n "$url" ] || { echo "No build found in the last 14 days at build.protomaps.com" >&2; exit 1; }
echo "    $url"

tiles="$DATA_DIR/tiles"
mkdir -p "$tiles"
part="$tiles/planet.pmtiles.part"

if [ -z "$bbox" ]; then
  free_gb=$(df -BG --output=avail "$tiles" | tail -1 | tr -dc 0-9)
  if [ "$free_gb" -lt 140 ]; then
    echo "Only ${free_gb} GB free in $tiles; the world map needs about 130 GB." >&2
    exit 1
  fi
  echo "==> Downloading the whole world (resumes if interrupted)"
  curl -fL --retry 10 --retry-delay 10 -C - -o "$part" "$url"
else
  echo "==> Extracting area $bbox"
  rm -f "$part"
  docker run --rm -v "$tiles:/out" protomaps/go-pmtiles:v1.30.3 \
    extract "$url" /out/planet.pmtiles.part --bbox="$bbox"
fi

mv -f "$part" "$tiles/planet.pmtiles"
echo "==> Map saved: $(du -h "$tiles/planet.pmtiles" | cut -f1)"

echo "==> Starting the tile server"
docker compose --profile maps up -d
docker compose --profile maps restart tileserver
# Old cached tiles belong to the previous map.
find "$TILE_CACHE_DIR" -mindepth 1 -delete 2>/dev/null || true
docker compose --profile maps restart tilecache

cat <<EOF

Map is live. Test a tile:
  https://tiles.${DOMAIN}/styles/light/5/22/12.png
Browse the map viewer:
  https://tiles.${DOMAIN}/
EOF
