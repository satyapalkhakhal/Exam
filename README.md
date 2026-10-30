# Arihant Capital — Recruitment Assessment

Standalone pnpm workspace: `apps/api` (Express + Prisma, port 4100), `apps/web` (React + Vite, port 5174), `packages/shared` (types and zod schemas used by both). Design: `docs/design.md`; full deployment spec: `docs/deployment.md`.

## Local setup

1. `pnpm install`
2. Create the databases `exam_db` and `exam_test` on local Postgres. Set the server timezone to UTC.
3. `cp apps/api/.env.example apps/api/.env.local` and `cp apps/api/.env.test.example apps/api/.env.test`, then fill them in. Secrets are 32+ chars and `JWT_CANDIDATE_SECRET` must differ from `JWT_ADMIN_SECRET`; `CONFIG_ENCRYPTION_KEY` is 64 hex chars (`openssl rand -hex 32`). Set `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` for the Super Admin.
4. Migrate: `pnpm --filter @exam/api migrate` (and `migrate:test` for `exam_test`).
5. Seed: `pnpm --filter @exam/api seed` (roles, settings, Super Admin). Add demo data with `SEED_DEMO=true pnpm --filter @exam/api seed`.
6. Run the API (`pnpm --filter @exam/api dev`) and the web app (`pnpm --filter @exam/web dev`).

While no SMS/email integration is configured, the static OTP is `123456` (`ALLOW_STATIC_OTP=true`). **Set `ALLOW_STATIC_OTP=false` before the live exam.**

## Checks

- `pnpm -r check-types`
- `pnpm --filter @exam/api test` (unit) and `pnpm --filter @exam/api test:int` (integration, needs `exam_test` and Redis)
- `pnpm --filter @exam/shared test`, `pnpm --filter @exam/web build`
- Production boot smoke (the compiled API runs as plain Node ESM, which `tsx` in dev and tests does not exercise): `docker build -f apps/api/Dockerfile -t exam-api:check .` runs it inside the image build and fails the build if any compiled module cannot load. To re-run it by hand against a built image (dummy values; nothing connects):

  ```
  docker run --rm -e APP_ENV=bootcheck -e LOG_DIR=/tmp/bootcheck-logs \
    -e DATABASE_URL=postgresql://u:p@127.0.0.1:1/x -e REDIS_URL=redis://127.0.0.1:1 \
    -e JWT_ADMIN_SECRET=bootcheck-admin-secret-0000000000000000 \
    -e JWT_CANDIDATE_SECRET=bootcheck-candidate-secret-000000000000 \
    -e CONFIG_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    -e PUBLIC_WEB_URL=https://exam.invalid -e CORS_ORIGIN=https://exam.invalid \
    exam-api:check node -e "import('./dist/app.js').then(()=>{console.log('ok');process.exit(0)})"
  ```

  Then run `./deploy/deploy-api.sh uat --migrate` once before go-live: it is the only end-to-end check of the image against a real Postgres and Redis.

## Deploying

Same pattern as the CRM: the API is a Docker container, Postgres and Redis are containers on the private `exam_net` network (no published ports, Redis has a password), the web app is static files in `/var/www/<domain>`, nginx terminates HTTPS. HTTPS is mandatory (geolocation and Secure cookies). Everything is separate from the CRM.

UAT and production can share a host: containers, network and volumes carry an env suffix (`exam_api_uat`, `exam_postgres_production`, `exam_net_uat`, `exam_pgdata_uat`, compose project `exam_<env>`), and the API listens on loopback `API_HOST_PORT` from the env file (default 4100 production, 4101 uat; point the UAT nginx block at 4101).

Files: `apps/api/Dockerfile`, `deploy/docker-compose.prod.yml`, `deploy/deploy-api.sh`, `deploy/deploy-web.sh`, `deploy/backup-db.sh`, `deploy/nginx/exam.conf`, `deploy/.env.production.example`.

First-time setup, in order:

1. Clone the repo to the server.
2. `cp deploy/.env.production.example apps/api/.env.production` and fill in every value (use `.env.uat` for UAT). The scripts refuse to run while any value contains `<` or `changeme`. Back up `CONFIG_ENCRYPTION_KEY`.
3. `EXAM_ENV=production docker compose -p exam_production --env-file apps/api/.env.production -f deploy/docker-compose.prod.yml up -d exam_postgres exam_redis`
4. `./deploy/deploy-api.sh production --migrate` (builds, migrates, starts, waits up to 60 s for `/health`).
5. Seed once: `docker exec exam_api_production node dist/infrastructure/db/seed.js`
6. `./deploy/deploy-web.sh production` (publishes to `/var/www/$EXAM_WEB_DOMAIN`).
7. Install `deploy/nginx/exam.conf` (edit domain and cert paths), then `nginx -t && systemctl reload nginx`.
8. Cron for backups, daily: `0 2 * * * /path/to/exam/deploy/backup-db.sh production >> /var/log/exam-backup.log 2>&1`

Updates: `git pull`, then `./deploy/deploy-api.sh production [--migrate]` and `./deploy/deploy-web.sh production`. The scripts never `git pull`. Each API image is tagged `exam-api:<timestamp>` and the last 3 are kept; roll back with `./deploy/deploy-api.sh production --image exam-api:<tag>`. Migrations only add things. **Do not redeploy the API during an exam window.** Use the same scripts with `uat` and a separate subdomain and env file for UAT.

### Production env gotchas

- **`PUBLIC_WEB_URL` must equal the browser origin exactly**: scheme, host and port, no trailing path, and no `www.` alias (if both `exam.example.com` and `www.exam.example.com` are served, redirect one to the other in nginx). The answer beacon and the activity-event endpoints only accept requests whose `Origin` matches it; on a mismatch every event batch and every pagehide save is refused with 403, and the integrity evidence is lost without any visible error to the candidate.
- **`TRUST_PROXY=1` behind nginx.** With `0` every request appears to come from the docker gateway IP, so the whole cohort shares one per-IP rate-limit bucket and the IP-change flags compare meaningless addresses.
- **`ALLOW_STATIC_OTP=false` for the live exam** (see the go-live checklist).
- **Keep `CONFIG_ENCRYPTION_KEY` with the database.** A DB copy restored under a different key cannot decrypt the stored SMS/email secrets; re-enter them in Admin → Integrations.

### Break-glass

Inside the container there is no `tsx` and no `src/`, so run the compiled scripts:

- Turn SMS and email delivery off without signing in (works even if `CONFIG_ENCRYPTION_KEY` is wrong): `docker exec exam_api_production node dist/scripts/disable-integrations.js`
- Reset an admin's password, unlock the account and sign it out everywhere (the password is read from a hidden prompt, so `-it` is required): `docker exec -it exam_api_production node dist/scripts/reset-admin-password.js <email>`

Locally: `pnpm --filter @exam/api admin:disable-integrations` and `pnpm --filter @exam/api admin:reset-password <email>`. Use `exam_api_uat` for UAT.

### Optional: DB-level append-only logs

The app never updates or deletes `activity_logs` or `admin_audit_logs`. To make the database refuse it as well (a guard against a code bug or a stray manual query), run once as the database owner after migrating:

```sql
REVOKE UPDATE, DELETE ON activity_logs, admin_audit_logs FROM exam_user;
```

`purge-candidates` scrubs IPs and user agents in `activity_logs`, so grant `UPDATE ON activity_logs` back for the purge run and revoke it again afterwards. The app user owns the tables, so this protects against mistakes, not against someone holding that user's password.

### Backups

`backup-db.sh` dumps contain candidate personal data and are handled accordingly:

- `umask 077`; the backup directory (`/var/backups/exam-<env>`, override with `BACKUP_DIR`) is created mode 700 and each file is mode 600.
- The dump is written to a temp file and moved into place only after `pg_dump` succeeds, so a failed run never leaves a truncated backup that looks good.
- Optional encryption: set `BACKUP_AGE_RECIPIENT` (an `age` public key) in the cron environment and the dump is piped through `age -r`, producing `.sql.gz.age`. Keep the private key off the server.
- Files older than 14 days are deleted.

### Go-live checklist

1. Log in as Super Admin and change the seeded password.
2. Admin → Integrations: enter the SMS and ZatpatMail credentials and use Send test on both.
3. Set `ALLOW_STATIC_OTP=false`, redeploy the API, and confirm a real code arrives and `123456` is rejected.
4. Create the Evaluator accounts.
5. Upload questions per role and check the preview.
6. Upload candidates per role and check the import summary against HR's counts (461).
7. Set each role's duration, window and instructions, then open the roles.
8. Dry run with 2-3 test candidates on real phones and laptops (OTP, location, paste blocked, autosave across refresh and offline, auto-submit, evaluator marking), then reset or delete them.
9. Take a manual DB backup right before the window opens.

### After the exam

Export results and take a final backup. Close the roles. After the agreed retention period (suggested 6 months), anonymise personal data while keeping marks: `pnpm --filter @exam/api purge-candidates --before YYYY-MM-DD` (dry run), then add `--yes` to apply. In the container: `docker exec exam_api_production node dist/scripts/purge-candidates.js --before YYYY-MM-DD --yes`.
