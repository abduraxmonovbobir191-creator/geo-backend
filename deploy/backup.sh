#!/usr/bin/env bash
# Saves a compressed copy of the main database to BACKUP_DIR and keeps the last 14 days.
# Run daily from cron, e.g. (crontab -e):
#   17 3 * * * cd /root/geo-backend/deploy && bash backup.sh >> /var/log/nexmap-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/nexmap-$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T db pg_dump -U nexmap nexmap | gzip > "$file"
find "$BACKUP_DIR" -name 'nexmap-*.sql.gz' -mtime +14 -delete
echo "Backup saved: $file ($(du -h "$file" | cut -f1))"

# Restore:
#   gunzip -c nexmap-YYYYMMDD-HHMM.sql.gz | docker compose exec -T db psql -U nexmap nexmap
