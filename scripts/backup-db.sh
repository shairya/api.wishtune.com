#!/usr/bin/env bash
# scripts/backup-db.sh — daily MySQL backup for Wishtune CRM.
#
# Reads MYSQL_* from the backend .env, writes a gzipped dump to
# $BACKUP_DIR (default: /var/backups/wishtune-crm) and deletes dumps older
# than $KEEP_DAYS (default 14).
#
# Install (as the user that runs the app):
#   chmod +x scripts/backup-db.sh
#   crontab -e
#   30 2 * * * /var/www/wishtune-crm-backend/scripts/backup-db.sh >> /var/log/wishtune-crm-backup.log 2>&1
# (02:30 server time, daily)

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/wishtune-crm}"
KEEP_DAYS="${KEEP_DAYS:-14}"

get_env() {
  # Last matching KEY=value line, surrounding quotes removed.
  grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

DB_HOST="$(get_env MYSQL_HOST)"; DB_HOST="${DB_HOST:-localhost}"
DB_PORT="$(get_env MYSQL_PORT)"; DB_PORT="${DB_PORT:-3306}"
DB_USER="$(get_env MYSQL_USER)"
DB_NAME="$(get_env MYSQL_DB)"
export MYSQL_PWD="$(get_env MYSQL_PASSWORD)"   # not visible in `ps`, unlike -p

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date +%Y%m%d_%H%M)"
OUT="$BACKUP_DIR/${DB_NAME}_${STAMP}.sql.gz"

mysqldump --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
  --single-transaction --quick --routines --triggers --no-tablespaces \
  "$DB_NAME" | gzip -9 > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
chmod 600 "$OUT"

find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -type f -mtime +"$KEEP_DAYS" -delete

echo "$(date -Is) backup ok: $OUT ($(du -h "$OUT" | cut -f1))"

# Restore:  gunzip -c <file>.sql.gz | mysql -u <user> -p <db>
