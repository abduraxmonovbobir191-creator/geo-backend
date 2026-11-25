#!/usr/bin/env bash
# Copies the finished world data to the main server, so the big hourly server can be switched off.
#   bash export-world.sh root@MAIN_SERVER /srv/nexmap        (the main server's DATA_DIR)
# Run it again if it stops: rsync continues where it left off.
set -euo pipefail
WORK="${WORK:-/srv/nexmap-build}"
TARGET="${1:?Usage: bash export-world.sh user@host /remote/DATA_DIR}"
DEST="${2:?Usage: bash export-world.sh user@host /remote/DATA_DIR}"
for part in valhalla nominatim; do
  [ -f "$WORK/$part/.done" ] || { echo "$part is not finished here (no $WORK/$part/.done)" >&2; exit 1; }
done
docker ps --format '{{.Names}}' | grep -q nexmap- && { echo "Stop the build containers first (docker stop ...)" >&2; exit 1; }
ssh "$TARGET" "mkdir -p '$DEST'/valhalla '$DEST'/nominatim"
# Routing tiles (the tar the server reads), then the Nominatim database and its flatnode file.
rsync -aP --inplace "$WORK/valhalla/" "$TARGET:$DEST/valhalla/" --exclude custom_files/planet.osm.pbf
rsync -aP --inplace "$WORK/nominatim/postgres/" "$TARGET:$DEST/nominatim/postgres/"
rsync -aP --inplace "$WORK/nominatim/flatnode/" "$TARGET:$DEST/nominatim/flatnode/"
echo "Copied. On the main server: docker compose --profile routing up -d valhalla  (see deploy/planet/README.md)"
