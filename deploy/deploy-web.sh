#!/usr/bin/env bash
# deploy/deploy-web.sh — build the exam web app and publish it as static files.
#
# Usage: ./deploy/deploy-web.sh <uat|production>
#
# Does NOT git pull. The target is /var/www/<EXAM_WEB_DOMAIN>, read from the
# same env file the API uses (apps/api/.env.<env>).

set -euo pipefail

ENV="${1:?Usage: $0 <uat|production>}"
case "$ENV" in uat|production) ;; *) echo "ERROR: env must be uat or production" >&2; exit 1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/api/.env.$ENV"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE is missing." >&2
  exit 1
fi
DOMAIN="$(grep -E '^EXAM_WEB_DOMAIN=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [ -z "$DOMAIN" ] || [[ "$DOMAIN" == *"<"* ]]; then
  echo "ERROR: EXAM_WEB_DOMAIN is not set in $ENV_FILE." >&2
  exit 1
fi
WWW_DIR="/var/www/$DOMAIN"

cd "$ROOT"
echo "===== Installing dependencies (web only) ====="
pnpm install --filter @exam/web... --frozen-lockfile

echo "===== Building web ($ENV) ====="
pnpm --filter @exam/web build
if [ ! -d "apps/web/dist" ]; then
  echo "ERROR: apps/web/dist not created. Build failed." >&2
  exit 1
fi

echo "===== Deploying to $WWW_DIR ====="
mkdir -p "$WWW_DIR"
rsync -a --delete apps/web/dist/ "$WWW_DIR/"

echo "===== Done: https://$DOMAIN ====="
