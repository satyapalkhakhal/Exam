#!/usr/bin/env bash
# deploy/restore-db.sh — restore a backup made by backup-db.sh into exam_postgres_<env>.
#
# Usage: ./deploy/restore-db.sh <uat|production> <backup-file> [--yes]
#
#   <backup-file>  exam_db-*.sql.gz, or exam_db-*.sql.gz.age (then set
#                  AGE_IDENTITY to the age private key file, kept off the server).
#   --yes          skip the typed confirmation (for scripted UAT refreshes).
#
# The live database is never dropped. The dump is first unpacked and checked
# (gzip intact, pg_dump's "dump complete" trailer present), then restored in a
# single transaction into a NEW database. Only if that succeeds is exam_api
# stopped, the live database renamed to <db>_pre_restore_<stamp> (kept as the
# rollback) and the restored one renamed into place, and the API started again.
# A failure before the swap leaves the live database and the API untouched.
#
# Not restored: Redis (login sessions, OTPs, rate limits, auto-submit jobs).
# Candidates and admins may have to sign in again; the minute sweep locks any
# restored IN_PROGRESS attempt that is past its deadline. The restored data
# must be used with the same CONFIG_ENCRYPTION_KEY it was written with, or the
# stored SMS/email secrets cannot be decrypted (re-enter them in Integrations).
# Do not run this during an exam window.

set -euo pipefail
umask 077

usage() { echo "Usage: $0 <uat|production> <backup-file> [--yes]" >&2; exit 1; }

ENV="${1:-}"; FILE="${2:-}"
[ -n "$ENV" ] && [ -n "$FILE" ] || usage
shift 2
case "$ENV" in uat|production) ;; *) echo "ERROR: env must be uat or production" >&2; exit 1 ;; esac

ASSUME_YES=false
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) ASSUME_YES=true ;;
    *) echo "ERROR: unknown option $1" >&2; usage ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/api/.env.$ENV"
PG_CONTAINER="exam_postgres_$ENV"
API_CONTAINER="exam_api_$ENV"
STAMP="$(date +%Y%m%d_%H%M%S)"

log() { echo "===== $* ====="; }
die() { echo "ERROR: $*" >&2; exit 1; }

[ -f "$FILE" ] || die "backup file not found: $FILE"
docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -q true || die "$PG_CONTAINER is not running"

# psql inside the Postgres container as its superuser; extra args go to psql.
pg() { docker exec -i "$PG_CONTAINER" sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$@"' psql "$@"; }

DB="$(docker exec "$PG_CONTAINER" sh -c 'printf %s "$POSTGRES_DB"')"
[ -n "$DB" ] || die "could not read POSTGRES_DB from $PG_CONTAINER"
RESTORE_DB="${DB}_restore_$STAMP"
OLD_DB="${DB}_pre_restore_$STAMP"

# ---- 1. Unpack and check the dump before touching anything ---------------
WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  # A restore database left behind by a failure before the swap is dropped.
  if [ "${SWAPPED:-false}" = false ] && [ "${CREATED:-false}" = true ]; then
    pg -d postgres -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\"" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

SQL="$WORK/dump.sql"
log "Unpacking $(basename "$FILE")"
case "$FILE" in
  *.sql.gz.age)
    [ -n "${AGE_IDENTITY:-}" ] || die "encrypted backup: set AGE_IDENTITY to the age private key file"
    command -v age >/dev/null || die "age is not installed"
    age -d -i "$AGE_IDENTITY" "$FILE" | gunzip > "$SQL"
    ;;
  *.sql.gz) gunzip -c "$FILE" > "$SQL" ;;
  *) die "expected a .sql.gz or .sql.gz.age file from backup-db.sh" ;;
esac
tail -n 5 "$SQL" | grep -q 'PostgreSQL database dump complete' \
  || die "the dump is incomplete (no 'dump complete' trailer); refusing to restore it"
echo "Dump OK ($(du -h "$SQL" | cut -f1) uncompressed)."

# ---- 2. Confirm -------------------------------------------------------------
echo
echo "This replaces database '$DB' in $PG_CONTAINER with $(basename "$FILE")."
echo "The API ($API_CONTAINER) is stopped for the swap. The current data is kept as '$OLD_DB'."
if [ "$ASSUME_YES" != true ]; then
  [ -t 0 ] || die "not a terminal; pass --yes to run non-interactively"
  read -r -p "Type the environment name ($ENV) to continue: " answer
  [ "$answer" = "$ENV" ] || die "aborted"
fi

# ---- 3. Restore into a new database ----------------------------------------
log "Restoring into $RESTORE_DB"
pg -d postgres -c "CREATE DATABASE \"$RESTORE_DB\" OWNER \"$(docker exec "$PG_CONTAINER" sh -c 'printf %s "$POSTGRES_USER"')\""
CREATED=true
pg -d "$RESTORE_DB" --single-transaction < "$SQL" >/dev/null

TABLES="$(pg -d "$RESTORE_DB" -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[ "${TABLES:-0}" -gt 0 ] || die "restored database has no tables"
LAST_MIGRATION="$(pg -d "$RESTORE_DB" -tA -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1" 2>/dev/null || echo unknown)"
echo "Restored $TABLES tables; last migration: $LAST_MIGRATION"

# ---- 4. Swap ------------------------------------------------------------------
API_WAS_RUNNING=false
if docker inspect -f '{{.State.Running}}' "$API_CONTAINER" 2>/dev/null | grep -q true; then
  API_WAS_RUNNING=true
  log "Stopping $API_CONTAINER"
  docker stop "$API_CONTAINER" >/dev/null
fi

log "Swapping $DB -> $OLD_DB, $RESTORE_DB -> $DB"
pg -d postgres >/dev/null <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid();
ALTER DATABASE "$DB" RENAME TO "$OLD_DB";
ALTER DATABASE "$RESTORE_DB" RENAME TO "$DB";
SQL
SWAPPED=true

# ---- 5. Start the API again ---------------------------------------------------
if [ "$API_WAS_RUNNING" = true ]; then
  log "Starting $API_CONTAINER"
  docker start "$API_CONTAINER" >/dev/null
  API_HOST_PORT=""
  [ -f "$ENV_FILE" ] && API_HOST_PORT="$(grep -E '^API_HOST_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  [ -n "$API_HOST_PORT" ] || { if [ "$ENV" = production ]; then API_HOST_PORT=4100; else API_HOST_PORT=4101; fi; }
  healthy=false
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$API_HOST_PORT/health" >/dev/null 2>&1; then healthy=true; break; fi
    sleep 2
  done
  if [ "$healthy" = true ]; then
    echo "API healthy."
  else
    echo "WARNING: API did not become healthy in 60s. Logs:" >&2
    docker logs --tail 50 "$API_CONTAINER" >&2 || true
  fi
fi

cat <<EOF

Restore complete: '$DB' now holds $(basename "$FILE").
- Previous data kept as '$OLD_DB'. Roll back with:
    docker stop $API_CONTAINER
    docker exec -i $PG_CONTAINER sh -c 'psql -U "\$POSTGRES_USER" -d postgres' <<'SQL'
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB';
    ALTER DATABASE "$DB" RENAME TO "${DB}_bad_$STAMP";
    ALTER DATABASE "$OLD_DB" RENAME TO "$DB";
    SQL
    docker start $API_CONTAINER
- Once satisfied, free the space: docker exec $PG_CONTAINER sh -c 'dropdb -U "\$POSTGRES_USER" $OLD_DB'
- If the backup predates the current code's migrations, run: ./deploy/deploy-api.sh $ENV --migrate
- Redis was not restored: users may need to sign in again.
EOF
