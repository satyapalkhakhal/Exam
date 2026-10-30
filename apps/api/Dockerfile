# apps/api/Dockerfile
#
# Multi-stage build for the exam API. The build context MUST be the exam/ repo
# root (not apps/api), because the install needs the root lockfile/workspace
# files and packages/shared:
#
#   docker build -f apps/api/Dockerfile -t exam-api .
#
# Env files are NOT copied in (see .dockerignore); deploy-api.sh passes the
# right one at run time. @exam/shared ships TypeScript source for the web app
# and tests, so the builder compiles it and points its package.json at dist/
# for this image only. The seed compiles into dist/, so
# `node dist/infrastructure/db/seed.js` works inside the container.

FROM node:24.18.0-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared ./packages/shared/
COPY apps/api ./apps/api/

RUN pnpm install --filter @exam/api... --frozen-lockfile
RUN pnpm --filter @exam/shared build \
 && pnpm --filter @exam/api build

# Runtime resolves @exam/shared to the compiled output.
RUN node -e "const fs=require('fs');const p='packages/shared/package.json';const j=JSON.parse(fs.readFileSync(p));j.main='dist/index.js';j.types='dist/index.d.ts';j.exports={'.':'./dist/index.js'};fs.writeFileSync(p,JSON.stringify(j,null,2))"

# Prod-only reinstall so the runner does not inherit typescript, tsx, @types/*.
RUN pnpm install --filter @exam/api... --frozen-lockfile --prod

# Boot smoke: load every compiled entry with the prod-only deps and a dummy
# env, so an ESM resolution error (e.g. extensionless imports in the generated
# Prisma client) fails the build instead of the first /health wait on deploy.
# Nothing connects: importing only builds the app, Redis/BullMQ are lazy.
RUN cd apps/api && env APP_ENV=bootcheck NODE_ENV=production LOG_DIR=/tmp/bootcheck-logs \
      DATABASE_URL=postgresql://u:p@127.0.0.1:1/x REDIS_URL=redis://127.0.0.1:1 \
      JWT_ADMIN_SECRET=bootcheck-admin-secret-0000000000000000 \
      JWT_CANDIDATE_SECRET=bootcheck-candidate-secret-000000000000 \
      CONFIG_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
      PUBLIC_WEB_URL=https://exam.invalid CORS_ORIGIN=https://exam.invalid \
      node -e "Promise.all(['./dist/app.js','./dist/infrastructure/queue/autoSubmit.worker.js','./dist/infrastructure/queue/sweep.js'].map((p)=>import(p))).then(()=>{console.log('boot smoke ok');process.exit(0)},(e)=>{console.error(e);process.exit(1)})" \
 && rm -rf /tmp/bootcheck-logs

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs --home /home/appuser appuser \
 && apk add --no-cache curl

COPY --from=builder --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /app/packages/shared ./packages/shared
COPY --from=builder --chown=appuser:nodejs /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=appuser:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=appuser:nodejs /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=appuser:nodejs /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder --chown=appuser:nodejs /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts

RUN mkdir -p /app/apps/api/logs && chown -R appuser:nodejs /app/apps/api/logs

WORKDIR /app/apps/api
USER appuser
ENV HOME=/home/appuser

EXPOSE 4100
ENV PORT=4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/health" || exit 1

CMD ["node", "dist/index.js"]
