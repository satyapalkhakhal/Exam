#!/usr/bin/env bash
# deploy/backup-db.sh <uat|production> — gzip'd pg_dump of exam_db into /var/backups/exam-<env>, 14-day retention.
# Dumps hold candidate PII, so the directory is 700, files are 600, and a dump
# is only moved into place after pg_dump succeeded (a failure leaves no
# truncated "good-looking" backup). Set BACKUP_AGE_RECIPIENT to encrypt with
# `age` (files then end in .sql.gz.age).
# Cron (daily 02:00): 0 2 * * * /path/to/exam/deploy/backup-db.sh production >> /var/log/exam-backup.log 2>&1

set -euo pipefail
umask 077

ENV="${1:?Usage: $0 <uat|production>}"
case "$ENV" in uat|production) ;; *) echo "ERROR: env must be uat or production" >&2; exit 1 ;; esac
BACKUP_DIR="${BACKUP_DIR:-/var/backups/exam-$ENV}"
RETENTION_DAYS=14
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  EXT="sql.gz.age"
else
  EXT="sql.gz"
fi
FINAL="$BACKUP_DIR/exam_db-$STAMP.$EXT"

install -d -m 700 "$BACKUP_DIR"
TMP="$(mktemp "$BACKUP_DIR/.exam_db-$STAMP.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  docker exec "exam_postgres_$ENV" sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip | age -r "$BACKUP_AGE_RECIPIENT" > "$TMP"
else
  docker exec "exam_postgres_$ENV" sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$TMP"
fi

chmod 600 "$TMP"
mv "$TMP" "$FINAL"
trap - EXIT

find "$BACKUP_DIR" -name 'exam_db-*.sql.gz*' -type f -mtime +"$RETENTION_DAYS" -delete
echo "Backup written: $FINAL"
