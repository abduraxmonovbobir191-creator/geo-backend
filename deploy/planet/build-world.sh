#!/usr/bin/env bash
# Builds Nex Map's own routing (Valhalla) and address search (Nominatim) for the WHOLE WORLD on a big rented server.
# Run it once, on the hourly server, then copy the result to the main server with export-world.sh and switch the big one off.
#
#   bash build-world.sh              # everything, one step after another
#   bash build-world.sh valhalla     # only routing
#   bash build-world.sh nominatim    # only address search
#
# Needs (checked below): 96 GB+ RAM (256 GB is better), ~1.5 TB free on a fast NVMe disk, 16+ cores.
# It is safe to run again: downloads resume and finished steps are skipped.
# NOT tested on a real server yet: watch the first minutes of each step and send me the log if something stops.
set -euo pipefail
cd "$(dirname "$0")"
WORK="${WORK:-/srv/nexmap-build}"      # put it on the big NVMe disk
STEP="${1:-all}"
PBF_URL="${PBF_URL:-https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf}"
THREADS="${THREADS:-$(nproc)}"

say() { printf '\n==> %s\n' "$*"; }

say "Checking the machine"
ram_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
free_gb=$(df -BG --output=avail "$(dirname "$WORK")" | tail -1 | tr -dc 0-9)
echo "    RAM ${ram_gb} GB, cores ${THREADS}, free disk ${free_gb} GB at $(dirname "$WORK")"
[ "$ram_gb" -ge 90 ] || { echo "Less than 96 GB of RAM: a world build will be very slow or fail. Use a bigger server." >&2; exit 1; }
[ "$free_gb" -ge 1400 ] || { echo "Less than ~1.4 TB free. A world build needs about 1.5 TB (Nominatim ~1 TB)." >&2; exit 1; }
dev=$(df --output=source "$(dirname "$WORK")" | tail -1 | xargs basename 2>/dev/null || true)
if [ -r "/sys/block/${dev%%[0-9]*}/queue/rotational" ] && [ "$(cat "/sys/block/${dev%%[0-9]*}/queue/rotational")" = "1" ]; then
  echo "This looks like a spinning disk (HDD). A world import on HDD takes weeks: use an NVMe server." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
command -v aria2c >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq aria2; }
mkdir -p "$WORK"/{osm,valhalla,nominatim/postgres,nominatim/flatnode}

say "Downloading the planet (about 85 GB, resumes if it stops)"
if [ ! -f "$WORK/osm/planet.osm.pbf" ]; then
  aria2c -x 8 -s 8 -k 64M -c --file-allocation=none -d "$WORK/osm" -o planet.osm.pbf.part "$PBF_URL"
  mv "$WORK/osm/planet.osm.pbf.part" "$WORK/osm/planet.osm.pbf"
fi
ls -lh "$WORK/osm/planet.osm.pbf"

build_valhalla() {
  if [ -f "$WORK/valhalla/.done" ]; then say "Valhalla: already built"; return; fi
  say "Valhalla: building routing tiles for the world (many hours; leave it running)"
  mkdir -p "$WORK/valhalla/custom_files"
  ln -sf "$WORK/osm/planet.osm.pbf" "$WORK/valhalla/custom_files/planet.osm.pbf"
  # gis-ops image: builds the tiles from every .pbf in custom_files on the first start, then serves on :8002.
  docker rm -f nexmap-valhalla-build >/dev/null 2>&1 || true
  docker run -d --name nexmap-valhalla-build -p 127.0.0.1:8002:8002 -v "$WORK/valhalla:/custom_files" \
    -e tile_urls= -e use_tiles_ignore_pbf=False -e force_rebuild=False -e build_admins=True -e build_time_zones=True \
    -e build_elevation=False -e build_tar=True -e serve_tiles=True -e server_threads="$THREADS" \
    ghcr.io/gis-ops/docker-valhalla/valhalla:latest >/dev/null
  echo "    Waiting for the build (follow it with: docker logs -f nexmap-valhalla-build)"
  until curl -fs http://127.0.0.1:8002/status >/dev/null 2>&1; do
    docker ps --format '{{.Names}}' | grep -q nexmap-valhalla-build || { echo "Valhalla container stopped; see: docker logs nexmap-valhalla-build" >&2; exit 1; }
    sleep 60
  done
  # a quick real route (Tashkent) proves the tiles work
  curl -fs -X POST http://127.0.0.1:8002/route -d '{"locations":[{"lat":41.3111,"lon":69.2797},{"lat":41.3264,"lon":69.2285}],"costing":"auto"}' | head -c 200 && echo
  docker stop nexmap-valhalla-build >/dev/null
  touch "$WORK/valhalla/.done"
  say "Valhalla: done"
}

build_nominatim() {
  if [ -f "$WORK/nominatim/.done" ]; then say "Nominatim: already imported"; return; fi
  say "Nominatim: importing the world (1-3 days; leave it running)"
  docker rm -f nexmap-nominatim-build >/dev/null 2>&1 || true
  # Settings for a 256 GB machine; with 128 GB the same values still work.
  docker run -d --name nexmap-nominatim-build --shm-size=8g -p 127.0.0.1:8088:8080 \
    -e PBF_PATH=/nominatim/data.osm.pbf -e THREADS="$THREADS" -e NOMINATIM_PASSWORD="${NOMINATIM_PASSWORD:-nexmap-build}" \
    -e NOMINATIM_FLATNODE_FILE=/nominatim/flatnode/flatnode.file -e IMPORT_WIKIPEDIA=false \
    -e POSTGRES_SHARED_BUFFERS=24GB -e POSTGRES_MAINTENANCE_WORK_MEM=64GB -e POSTGRES_AUTOVACUUM_WORK_MEM=4GB \
    -e POSTGRES_WORK_MEM=512MB -e POSTGRES_EFFECTIVE_CACHE_SIZE=160GB -e POSTGRES_SYNCHRONOUS_COMMIT=off \
    -e POSTGRES_FULL_PAGE_WRITES=off -e POSTGRES_CHECKPOINT_TIMEOUT=60min -e POSTGRES_MAX_WAL_SIZE=200GB \
    -v "$WORK/osm/planet.osm.pbf:/nominatim/data.osm.pbf:ro" -v "$WORK/nominatim/postgres:/var/lib/postgresql/16/data" \
    -v "$WORK/nominatim/flatnode:/nominatim/flatnode" mediagis/nominatim:5.3 >/dev/null
  echo "    Waiting for the import (follow it with: docker logs -f nexmap-nominatim-build)"
  until curl -fs "http://127.0.0.1:8088/search?q=Tashkent&format=json" 2>/dev/null | grep -q lat; do
    docker ps --format '{{.Names}}' | grep -q nexmap-nominatim-build || { echo "Nominatim container stopped; see: docker logs nexmap-nominatim-build" >&2; exit 1; }
    sleep 120
  done
  docker stop -t 600 nexmap-nominatim-build >/dev/null   # a clean stop, so the copy is consistent
  touch "$WORK/nominatim/.done"
  say "Nominatim: done"
}

case "$STEP" in
  all) build_valhalla; build_nominatim ;;
  valhalla) build_valhalla ;;
  nominatim) build_nominatim ;;
  *) echo "Usage: bash build-world.sh [all|valhalla|nominatim]" >&2; exit 1 ;;
esac

say "Finished. Next: bash export-world.sh user@MAIN_SERVER /path/on/main/server"
