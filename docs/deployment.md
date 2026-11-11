# Arihant Recruitment Exam — Deployment Plan

Date: 2026-10-31 · Companion to `design.md`

The pattern is the same one the CRM already uses on UAT, so the team knows it:
- the API is a Docker container started by a deploy script
- Postgres and Redis run as containers on a private Docker network
- the web app is built to static files and rsynced to `/var/www`
- nginx terminates HTTPS in front of both

Everything is separate from the CRM: its own containers, network, database, ports and domain. The exam can be deployed, restarted or deleted without touching the CRM.

## 1. What the user must provide

| Item | Placeholder used below |
|---|---|
| Server (Linux, Docker, nginx, Node 24 + pnpm for the web build) | `EXAM-SERVER` |
| Public domain for the exam | `exam.arihantcapital.com` |
| TLS certificate for that domain (company wildcard or Let's Encrypt) | `/etc/nginx/ssl/exam.*` |
| Outbound HTTPS from the server to the SMS gateway and `api.zatpatmail.com` | — |
| SMTP/SMS credentials | entered later in **Admin → Integrations** |

HTTPS is **mandatory**, not optional: browser geolocation (location at login) and Secure cookies don't work over plain HTTP.

## 2. Topology

```
Internet ──HTTPS──► nginx (host)  exam.arihantcapital.com
                     ├── /            → /var/www/exam.arihantcapital.com   (static React build)
                     └── /api/        → 127.0.0.1:4100  ─►  exam_api (container :4100)
                                                              │  docker network: exam_net
                                                              ├─► exam_postgres (no published port)
                                                              └─► exam_redis    (password, no published port)
```

- **One origin** for candidate and admin (`/` and `/admin`), so there is no CORS in production and the cookies are first-party.
- The API is published on **127.0.0.1:4100 only**, so it is reachable through nginx and not directly from the internet.
- Postgres and Redis have **no published ports**. Redis **has a password**, unlike the CRM's UAT setup.

## 3. Files the project ships (built in the implementation plan)

```
exam/
├── apps/api/Dockerfile              multi-stage, node:24-alpine, non-root user, HEALTHCHECK /health
├── deploy/
│   ├── docker-compose.prod.yml      exam_postgres + exam_redis + exam_api on exam_net, named volumes, restart: unless-stopped
│   ├── deploy-api.sh  <uat|production> [--migrate]   build image → (optional) prisma migrate deploy → recreate container → wait for /health
│   ├── deploy-web.sh  <uat|production>               pnpm build → rsync --delete dist/ to /var/www/<domain>
│   ├── nginx/exam.conf              server block (below)
│   ├── backup-db.sh                 pg_dump | gzip → /var/backups/exam (dir 700, files 600, temp-file-then-mv, optional `age` encryption via BACKUP_AGE_RECIPIENT), keeps 14 days (cron)
│   └── .env.production.example      every variable, documented, no secrets
└── README.md                        "Deploying" section = this document, condensed
```

The deploy scripts differ from the CRM's in a few ways, to avoid gotchas the CRM has already hit:
- They do **not** run `git pull` themselves. You pull first, so a pull can't overwrite the server's env file.
- They are committed as executable.
- They **fail loudly** if the env file is missing or still contains placeholder values.

## 4. Environment (`apps/api/.env.production`, on the server only, never committed)

```
NODE_ENV=production
PORT=4100
DATABASE_URL=postgresql://exam_user:<strong>@exam_postgres:5432/exam_db
REDIS_URL=redis://:<strong>@exam_redis:6379
JWT_ADMIN_SECRET=<64 random bytes>          # openssl rand -hex 64
JWT_CANDIDATE_SECRET=<64 random bytes>      # different from the admin one
CONFIG_ENCRYPTION_KEY=<32 bytes hex>        # encrypts SMS/email secrets in DB — back this up; losing it = re-enter creds
TRUST_PROXY=1
COOKIE_SECURE=true
PUBLIC_WEB_URL=https://exam.arihantcapital.com
CORS_ORIGIN=https://exam.arihantcapital.com
ALLOW_STATIC_OTP=true                       # MUST be false before the real exam
SEED_ADMIN_EMAIL=...
SEED_ADMIN_PASSWORD=...                     # change on first login
```

The API validates all of these at startup and refuses to boot if any are missing.

## 5. nginx (`deploy/nginx/exam.conf`)

- Port 80 redirects to 443. TLS 1.2+ and HSTS are on.
- `location /api/` → `proxy_pass http://127.0.0.1:4100;` with `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Real-IP` set. The API's IP logging and same-IP flags depend on these headers.
- `location /socket.io/` is not needed in v1.
- `large_client_header_buffers 4 16k` (the CRM hit the 4 KB default on UAT).
- `client_max_body_size 6m` for CSV/XLSX uploads.
- `location /` → `try_files $uri /index.html;`. Hashed `/assets/*` are cached for a year and `index.html` is `no-cache`, so a redeploy is picked up immediately.
- Security headers: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy: geolocation=(self)` and a CSP limited to self.
- `limit_req` on `/api/candidate/auth/` as an outer layer, in addition to the app's own Redis rate limits.

## 6. First-time setup (run by you, in order)

1. Copy or move the `exam/` folder to its own repo, then clone it to the server, e.g. `~/git/arihant-exam`.
2. Create `apps/api/.env.production` from the example and fill in the secrets.
3. `EXAM_ENV=production docker compose -p exam_production --env-file apps/api/.env.production -f deploy/docker-compose.prod.yml up -d exam_postgres exam_redis`
4. `./deploy/deploy-api.sh production --migrate` (builds, applies migrations, starts the API, waits for `/health`).
5. Seed once: `docker exec exam_api_production node dist/infrastructure/db/seed.js` (7 roles, settings, Super Admin, empty integration rows).
6. `./deploy/deploy-web.sh production`
7. Install `deploy/nginx/exam.conf`, then run `nginx -t && systemctl reload nginx`.
8. Add the cron entry for `backup-db.sh` (daily, e.g. 02:00). Dumps hold candidate PII: the script uses `umask 077`, a 700 directory, 600 files, and moves a dump into place only after `pg_dump` succeeds. Set `BACKUP_AGE_RECIPIENT` to encrypt with `age` (`.sql.gz.age`).

## 7. Go-live checklist (before candidates get the link)

1. Log in as the Super Admin and change the seeded password.
2. **Admin → Integrations:** enter the SMS and ZatpatMail credentials. Use **Send test** on both, to your own mobile and email.
3. Set `ALLOW_STATIC_OTP=false` and redeploy the API. Confirm that a login now delivers a **real** code and that `123456` is rejected.
4. Create the Evaluator accounts.
5. Upload the questions for each role and check them in the preview.
6. Upload the candidates for each role and check the import summary against HR's counts (461).
7. Set each role's duration, exam window and instructions, then open the roles.
8. **Dry run:** use 2–3 test candidates on real phones/laptops over mobile data and over office Wi-Fi. Check that:
   - OTP arrives
   - location is captured
   - paste is blocked and flagged
   - autosave survives a refresh and an aeroplane-mode toggle
   - auto-submit fires
   - an evaluator can mark the attempt
   Afterwards reset the test candidates' attempts, or delete them.
9. Take a manual DB backup right before the exam window opens.

## 8. During the exam

- Watch: `docker logs -f exam_api_production`, `docker stats`, and the admin dashboard's in-progress counter.
- Load: 461 concurrent candidates × 1 save every ~2 s ≈ under 250 req/s of small JSON. One API container (with Postgres pool size ~20) handles this, so no scaling work is needed.
- **Do not redeploy the API during an exam window.** If you must restart:
  - timers are server-side, so candidates lose no time
  - the client retries saves, so they lose no text
  - the auto-submit sweep catches any deadline that passed while the API was down

## 9. Updates and rollback

**2026-11-10 — colleges and drives (migration `20261110090000_colleges_drives_rounds`).** This
migration restructures data: every job role becomes Round 1 with one drive at **IIT Guwahati
(IITG), batch "Nov 2026"** (all existing candidates are from IITG), and `exam_settings` is
dropped. Before deploying with `--migrate`:

1. Take a database backup (`pg_dump`), and do it with the exam closed.
2. Record the counts that must not change:
   ```sql
   select (select count(*) from candidates) c, (select count(*) from exam_attempts) at,
          (select count(*) from answers) an, (select count(*) from attempt_evaluations) ev,
          (select count(*) from ai_question_scores) ai, (select count(*) from email_dispatches) em,
          (select count(*) from questions) q, (select count(*) from job_roles) r;
   ```
3. Deploy API **and** web together (`deploy-api.sh production --migrate`, then `deploy-web.sh production`):
   the old web app calls routes that no longer exist.
4. Run the same query: every number must match. Also check
   `select count(*) from candidates where drive_id is null` is 0 and
   `select count(*) from exam_rounds` equals the job role count.
5. Rename the college or batch on the Colleges / Job profiles pages if needed.


**2026-11-10 — MCQ questions (migration `20261110120000_mcq_questions`).** Additive: new
columns with defaults (question type, options, correct option, negative marking per round, MCQ
snapshots on attempt questions, the MCQ choice on answers, MCQ subtotals on attempts) and every
marks column widened from `decimal(6,1)`/`(7,1)` to `decimal(8,2)` (quarter-mark deductions). No
row is changed or removed; existing questions become `WRITTEN`.

1. Back up first, as always, and take the counts query above before and after: every number must match.
2. Deploy API **and** web together (`deploy-api.sh production --migrate`, then `deploy-web.sh production`):
   the answer and marking payloads gained fields the old web app does not send or show.
3. Don't change a round's negative marking once candidates have started: it is locked with the
   questions (423), and it is frozen into every attempt when the candidate starts.
4. This release also fixes candidate autosave (every answer save returned 400 since commit `4b93638`:
   request params were dropped by validation). Deploying it restores autosave.

- Update: `git pull` → `./deploy/deploy-api.sh production [--migrate]` → `./deploy/deploy-web.sh production`.
- `deploy-api.sh` tags every image with its timestamp and keeps the last 3. To roll back, run `deploy-api.sh production --image exam-api:<tag>`.
- Migrations only add things. A migration that removes something must ship as a separate, later release.

## 10. After the exam

- Export results (XLSX) and take a final DB backup.
- Data retention: candidate data, including location and IP, is personal data. Agree a retention period with HR. *Builder's suggestion:* 6 months, after which a `purge-candidates` script anonymises personal fields and keeps the marks.
- Switch the roles to closed, so no late logins can start an exam.

## 11. UAT first

UAT and production can run side by side on one host: container, network and volume names carry the env suffix (`exam_api_uat`, `exam_net_uat`, ...), the compose project is `exam_<env>`, and `API_HOST_PORT` in the env file sets the loopback port (default 4100 production, 4101 uat). `backup-db.sh <uat|production>` writes to `/var/backups/exam-<env>`.

Use the same scripts with `uat` instead of `production`, a separate env file, and a separate subdomain (e.g. `uatexam.arihantcapital.com`). Run the full go-live checklist on UAT before production.
