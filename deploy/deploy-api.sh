#!/usr/bin/env bash
# deploy/deploy-api.sh — build the API image and (re)start exam_api.
#
# Usage: ./deploy/deploy-api.sh <uat|production> [--migrate] [--image tag]
#
# Does NOT git pull: pull first, so a pull can never overwrite the server's env
# file. --migrate runs `prisma migrate deploy` before the swap. --image skips
# the build and starts an existing tag (rollback).

set -euo pipefail

ENV="${1:?Usage: $0 <uat|production> [--migrate] [--image tag]}"
shift
case "$ENV" in uat|production) ;; *) echo "ERROR: env must be uat or production" >&2; exit 1 ;; esac

MIGRATE=false
IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --migrate) MIGRATE=true ;;
    --image) IMAGE="${2:?--image needs a tag}"; shift ;;
    *) echo "ERROR: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/api/.env.$ENV"
PROJECT="exam_$ENV"
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$ROOT/deploy/docker-compose.prod.yml")
NETWORK="exam_net_$ENV"
API_CONTAINER="exam_api_$ENV"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE is missing. Create it from deploy/.env.production.example." >&2
  exit 1
fi

# Only real KEY=VALUE lines count (comments are skipped). Required keys must be
# non-empty, with no <placeholder> and no 'changeme' in the value.
REQUIRED_KEYS="DATABASE_URL REDIS_URL POSTGRES_PASSWORD REDIS_PASSWORD JWT_ADMIN_SECRET JWT_CANDIDATE_SECRET CONFIG_ENCRYPTION_KEY PUBLIC_WEB_URL CORS_ORIGIN EXAM_WEB_DOMAIN SEED_ADMIN_EMAIL SEED_ADMIN_PASSWORD"
BAD=""
PLACEHOLDER_RE='<[^>]*>'
for key in $REQUIRED_KEYS; do
  line="$(grep -E "^[[:space:]]*$key=" "$ENV_FILE" | tail -n1 || true)"
  value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"
  if [ -z "$line" ] || [ -z "${value// /}" ] || [[ "$value" =~ $PLACEHOLDER_RE ]] || [[ "${value,,}" == *changeme* ]]; then
    BAD="$BAD $key"
  fi
done
if [ -n "$BAD" ]; then
  echo "ERROR: $ENV_FILE has missing, empty or placeholder values for:$BAD" >&2
  exit 1
fi
if grep -vE '^[[:space:]]*(#|$)' "$ENV_FILE" | grep -qiE '<[^>]*>|changeme'; then
  echo "ERROR: $ENV_FILE still contains placeholder values (<...> or changeme)." >&2
  exit 1
fi

API_HOST_PORT="$(grep -E '^API_HOST_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
if [ -z "$API_HOST_PORT" ]; then
  if [ "$ENV" = production ]; then API_HOST_PORT=4100; else API_HOST_PORT=4101; fi
fi
export API_HOST_PORT EXAM_ENV="$ENV"

export EXAM_ENV_FILE="$ENV_FILE"

if [ -z "$IMAGE" ]; then
  IMAGE="exam-api:$(date +%Y%m%d%H%M%S)"
  echo "===== Building $IMAGE ====="
  docker build -f "$ROOT/apps/api/Dockerfile" -t "$IMAGE" -t exam-api:latest "$ROOT"
fi
export EXAM_API_IMAGE="$IMAGE"

echo "===== Ensuring Postgres and Redis are up ====="
"${COMPOSE[@]}" up -d exam_postgres exam_redis  # service names; containers carry the env suffix

if [ "$MIGRATE" = true ]; then
  echo "===== Applying migrations ====="
  docker run --rm --network "$NETWORK" --env-file "$ENV_FILE" "$IMAGE" node_modules/.bin/prisma migrate deploy
fi

echo "===== Starting exam_api ($IMAGE) ====="
"${COMPOSE[@]}" up -d --no-deps --force-recreate exam_api

echo "===== Waiting for /health (up to 60s) ====="
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$API_HOST_PORT/health" >/dev/null 2>&1; then
    echo "API healthy."
    echo "===== Pruning old images (keeping the last 3) ====="
    { docker images exam-api --format '{{.Tag}}' | grep -E '^[0-9]{14}$' || true; } | sort -r | tail -n +4 \
      | while read -r tag; do docker rmi "exam-api:$tag" || true; done
    exit 0
  fi
  sleep 2
done

echo "ERROR: API did not become healthy in 60s. Logs:" >&2
docker logs --tail 50 "$API_CONTAINER" >&2 || true
exit 1
