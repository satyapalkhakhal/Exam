# Arihant Recruitment Exam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, timed, descriptive-answer recruitment exam platform (admin + evaluator + candidate) inside `exam/`. It must be self-contained, so it can be moved to its own repo.

**Architecture:** A pnpm workspace with `apps/api` (Express + Prisma + Redis + BullMQ) and `apps/web` (React 19 + Vite). Both share zod schemas/types from `packages/shared`.
- The API follows the CRM's layout: one folder per module, with routes/controller/service/repository/schemas, a barrel, a central error handler, and one response shape.
- The timer and the auto-submit are owned by the server.
- Paste prevention runs in the browser, and the server double-checks it with typed-vs-grown evidence.

**Tech Stack:**
- Node 24, TypeScript 5 (ESM), Express 4, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL, ioredis, BullMQ.
- zod 3, bcrypt, jsonwebtoken, cookie-parser, helmet, cors, compression, express-rate-limit + rate-limit-redis, multer, csv-parse, exceljs, ua-parser-js, winston + winston-daily-rotate-file.
- React 19, Vite, React Router 7, Tailwind 3, Radix/shadcn, TanStack Query 5, Zustand 5, React Hook Form + zod resolver, lucide-react.
- Tests: `node:test` via `tsx` (same runner as the CRM).

**Spec:** `exam/docs/design.md` (product + engineering) and `exam/docs/deployment.md` (deployment). Read both before starting any task.

## Global Constraints

- **Standalone.** Nothing in `exam/` may import, symlink or relatively path into the CRM (`../apps`, `@repo/*`). Copy anything you borrow. The CRM at `/home/arihant/Desktop/inhousecrm/apps` is read-only reference.
- **pnpm only.** One lockfile, `exam/pnpm-lock.yaml`. Package names: `@exam/api`, `@exam/web`, `@exam/shared`.
- **Never `git add` / `git commit` / `git push`** (user rule). Each task ends with a **Pause** step: show `git status --short exam/` and a summary, then wait for the user.
- **The user applies migrations and seeds.** The implementer writes migrations and the seed but never runs `prisma migrate`, `db push` or the seed against any DB, and never edits a real `.env*` (only `.env.example`). Hand over the exact commands.
- **The user runs the dev servers.** Verify with `pnpm -r check-types`, `pnpm --filter @exam/api test` and `pnpm --filter @exam/web build`. Don't start `vite`/`tsx watch`.
- Ports: API **4100**, web **5174**. DB `exam_db`, test DB `exam_test`.
- Response shape: `{ success: true, data }` / `{ success: false, error: { message, code } }`. No stack traces to the client.
- Never log OTPs, passwords, tokens, integration secrets, answer text or coordinates. Mask emails/mobiles with `maskEmail` / `maskMobile`.
- Defaults: exam duration **60** min; OTP TTL **300** s, **5** attempts, **60** s resend cooldown; static OTP **`123456`**; save grace **10** s.
- Bulk-insert flag: grown > typed + **50** chars, or typed rate > **15** chars/s.
- Location flags: **50 km** login→start, **100 m** between candidates, **3** candidates per IP.
- Marks: 0…max, in steps of **0.5**.
- Admin lockout: **5** failed passwords → **15** min. Access JWT **15 min**; refresh token **7 d** admin / **12 h** candidate, rotated.
- Copy: product name "Arihant Capital — Recruitment Assessment". Login footer keeps the CRM's SEBI line.
- Comments follow the CRM style: a file header that says what the file is and *why*, and no narration.

## Review Focus

- **Out-of-order or late autosaves:** a stale save (lower `clientSeq`) arriving after a newer one must not overwrite it, and a save arriving after `endsAt + 10 s` must be rejected without losing the last accepted text. → Task 10 tests `saveAnswer ignores lower clientSeq` and `rejects after grace`.
- **Two tabs or devices:** a save carrying an old `sessionId` must get `409 SESSION_SUPERSEDED`, and taking over must keep the timer. → Task 10 tests `rejects foreign session` and `resume issues new session, same endsAt`.
- **A messy HR spreadsheet:** BOM, header case and whitespace differences, Excel numeric cells (`254101009` as a number, `97.6` as `97.6000001`), empty trailing rows, duplicate emails within the file. → Task 9 tests in `candidateImport.parser.test.ts`.
- **Evaluator data leak:** no evaluator endpoint may ever return name, email, mobile, roll number, academics or location. → Task 11 test `evaluator payload has no PII keys` (deep key scan).
- **Restart or lost job during the exam:** an attempt past its deadline with no BullMQ job must still be auto-submitted by the sweep. → Task 10 test `sweep auto-submits expired in-progress attempts`.

---

## File Structure

```
exam/
├── package.json · pnpm-workspace.yaml · tsconfig.base.json · .gitignore · .npmrc · README.md
├── packages/shared/src/
│   ├── index.ts                  barrel
│   ├── enums.ts                  AdminRole, CandidateStatus, AttemptStatus, ActivityEvent, LocationPermission, …
│   ├── api.ts                    ApiSuccess/ApiFailure types, ErrorCode union
│   ├── wordCount.ts              countWords(text) — used by both sides
│   └── schemas/                  auth.ts · roles.ts · questions.ts · candidates.ts · exam.ts · evaluation.ts · integrations.ts
├── apps/api/
│   ├── package.json · tsconfig.json · tsconfig.test.json · prisma.config.ts · .env.example · Dockerfile
│   ├── prisma/schema.prisma · prisma/migrations/<ts>_init/migration.sql
│   ├── src/index.ts (boot) · src/app.ts (express wiring) · src/router.ts
│   ├── src/infrastructure/
│   │   ├── config/env.ts         zod-validated env
│   │   ├── db/prisma.ts · db/seed.ts
│   │   ├── redis/redis.ts
│   │   ├── queue/autoSubmit.queue.ts · queue/autoSubmit.worker.ts · queue/sweep.ts
│   │   ├── logger/logger.ts
│   │   └── crypto/secretBox.ts   AES-256-GCM
│   ├── src/shared/
│   │   ├── errors.ts             AppError + helpers
│   │   ├── http.ts               ok(res, data, status?)
│   │   ├── middleware/           errorHandler · validate · authenticateAdmin · authenticateCandidate · authorize · rateLimit · requestId
│   │   └── utils/                piiMask · hash · clientInfo · geo · spreadsheet · csvEscape
│   ├── src/modules/
│   │   ├── systemConfig/         encrypted key/value config + cache
│   │   ├── messaging/            sms.client · email.client · otpDelivery.service
│   │   ├── otp/                  otp.service (Redis)
│   │   ├── audit/                audit.service + routes (list)
│   │   ├── adminAuth/            login, otp verify, refresh, logout, me
│   │   ├── adminUsers/
│   │   ├── integrations/         GET/PUT/test-send
│   │   ├── candidateAuth/        request-otp, verify-otp, refresh, logout, me, location
│   │   ├── jobRoles/             roles + exam settings
│   │   ├── questions/            CRUD, lock/unlock, import (parser + service)
│   │   ├── candidates/           list/detail/edit, import, reset, exempt
│   │   ├── exam/                 start, state, save, events, submit, autoSubmit, integrity, locationFlags
│   │   ├── evaluation/           submissions, lock, draft, submit, reopen
│   │   └── results/              decisions, leaderboard, dashboard stats, exports
│   ├── src/scripts/              disable-integrations.ts · reset-admin-password.ts
│   └── tests/                    *.test.ts (unit) · integration/*.int.test.ts (exam_test DB)
├── apps/web/
│   ├── package.json · vite.config.ts · tailwind.config.ts · postcss.config.js · index.html · tsconfig.json
│   ├── public/                   logo-light.svg · logo-dark.svg · favicon.svg (copied)
│   └── src/
│       ├── main.tsx · App.tsx · index.css (copied theme)
│       ├── lib/                  api.ts (apiFetch) · utils.ts (cn) · browserInfo.ts · geolocation.ts · pasteGuard.ts · autosave.ts · serverClock.ts
│       ├── stores/               adminAuth.ts · candidateAuth.ts
│       ├── components/ui/        copied shadcn parts
│       ├── components/auth/      AuthPageShell.tsx · OtpForm.tsx
│       ├── components/layout/    AdminLayout.tsx · AdminRoute.tsx · CandidateRoute.tsx
│       ├── components/location/  LocationGate.tsx · LocationHelp.tsx
│       ├── components/exam/      ExamHeader · QuestionPalette · AnswerBox · SaveStatus · SubmitDialog
│       ├── components/import/    ImportWizard.tsx (shared by candidates + questions)
│       ├── pages/admin/          Login · Dashboard · Candidates · CandidateDetail · Questions · Roles · Submissions · Marking · Leaderboard · AdminUsers · Integrations · AuditLog
│       └── pages/candidate/      Login · Location · Dashboard · Exam · Submitted
│       └── tests/                *.test.ts for lib/ pure helpers
└── deploy/                       docker-compose.prod.yml · deploy-api.sh · deploy-web.sh · nginx/exam.conf · backup-db.sh · .env.production.example
```

---

### Task 1: Workspace, shared package and API skeleton

**Files:**
- Create: `exam/package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore` (node_modules, dist, `.env*` except `.env.example`, logs), `.npmrc`, `README.md` (setup section only for now)
- Create: `packages/shared/{package.json,tsconfig.json}`, `src/{index.ts,enums.ts,api.ts,wordCount.ts}`
- Create: `apps/api/{package.json,tsconfig.json,tsconfig.test.json,.env.example}`, `src/{index.ts,app.ts,router.ts}`, `src/infrastructure/config/env.ts`, `src/infrastructure/logger/logger.ts`, `src/shared/{errors.ts,http.ts}`, `src/shared/middleware/{errorHandler.ts,validate.ts,requestId.ts}`, `src/shared/utils/piiMask.ts`
- Test: `apps/api/tests/env.test.ts`, `errorHandler.test.ts`, `piiMask.test.ts`, `packages/shared/tests/wordCount.test.ts`

**Interfaces:**
- Produces:
  - `loadEnv(source: NodeJS.ProcessEnv): Env` and `env: Env`. Keys: `NODE_ENV, PORT(4100), DATABASE_URL, REDIS_URL, JWT_ADMIN_SECRET(min 32), JWT_CANDIDATE_SECRET(min 32, ≠ admin), CONFIG_ENCRYPTION_KEY(64 hex), TRUST_PROXY(int, 0), COOKIE_SECURE(bool, false), PUBLIC_WEB_URL, CORS_ORIGIN, ALLOW_STATIC_OTP(bool, true), SEED_ADMIN_EMAIL?, SEED_ADMIN_PASSWORD?`. Reads `.env.${APP_ENV ?? 'local'}` like the CRM.
  - `class AppError(statusCode: number, code: ErrorCode, message: string)` with helpers `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `tooMany`.
  - `ok(res, data, status = 200)`.
  - `validate({ body?, query?, params? }: ZodSchemas)`: middleware that replaces `req.body/query/params` with parsed values and throws `badRequest('VALIDATION_ERROR')` carrying zod issue paths.
  - `maskEmail(e)`: `k.ajith@iitg.ac.in` → `k****h@iitg.ac.in`. `maskMobile(m)`: `9876543210` → `98******10`.
  - `countWords(text: string): number`: splits on Unicode whitespace and ignores empty tokens.
  - `ErrorCode` union, which every later task extends here: `VALIDATION_ERROR | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | RATE_LIMITED | INTERNAL_ERROR | OTP_INVALID | OTP_EXPIRED | OTP_LOCKED | OTP_COOLDOWN | OTP_DELIVERY_UNCONFIGURED | OTP_DELIVERY_FAILED | ACCOUNT_LOCKED | EXAM_NOT_OPEN | EXAM_WINDOW_CLOSED | LOCATION_REQUIRED | ALREADY_ATTEMPTED | ATTEMPT_LOCKED | SESSION_SUPERSEDED | QUESTIONS_LOCKED | EVALUATION_LOCKED | MARKS_OUT_OF_RANGE | ROLE_CHANGE_FORBIDDEN`
  - `GET /health` → `{ success: true, data: { status: 'ok' } }`.

- [ ] **Step 1: Write the failing tests**
  - `env.test.ts`:
    - `loadEnv` throws when `JWT_CANDIDATE_SECRET === JWT_ADMIN_SECRET`
    - `loadEnv` throws when `CONFIG_ENCRYPTION_KEY` is not 64 hex characters
    - `ALLOW_STATIC_OTP: 'false'` parses to `false`
    - `PORT` defaults to `4100`
  - `errorHandler.test.ts`:
    - an `AppError(409,'CONFLICT','x')` produces status 409 and body `{success:false,error:{message:'x',code:'CONFLICT'}}`
    - a plain `Error('db down')` produces 500 with message `'Internal server error'` and no `stack` key
  - `piiMask.test.ts`: the two examples above.
  - `wordCount.test.ts`:
    - `countWords('')===0`
    - `countWords('  a  b\n\tc ')===3`
    - `countWords('नमस्ते दुनिया')===2`
- [ ] **Step 2: Run** `pnpm install && pnpm --filter @exam/api test && pnpm --filter @exam/shared test`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the files listed. `app.ts` wires `helmet()`, `cors({origin: env.CORS_ORIGIN, credentials: true})`, `compression()`, `express.json({limit:'256kb'})`, `cookieParser()`, `requestId`, `app.set('trust proxy', env.TRUST_PROXY)`, the router under `/api`, `/health`, then `errorHandler`. `index.ts` boots the server and handles SIGTERM. Logger: winston with a JSON console transport plus daily-rotate files under `logs/`.
- [ ] **Step 4: Run** the tests and `pnpm -r check-types`. Expected: PASS, 0 type errors.
- [ ] **Step 5: Pause.** Show `git status --short exam/` and wait for the user.

---

### Task 2: Prisma schema, initial migration and seed

**Files:**
- Create: `apps/api/prisma.config.ts` (same shape as the CRM's: loads `.env.${APP_ENV}`), `prisma/schema.prisma`, `prisma/migrations/<YYYYMMDDHHMMSS>_init/migration.sql` (generated with `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`, which needs no DB), `src/infrastructure/db/prisma.ts`, `src/infrastructure/db/seed.ts`
- Test: `apps/api/tests/seed.data.test.ts`

**Interfaces:**
- Produces: the Prisma models named exactly as in design §11, plus `candidate_login_logs`. Field and enum names used by later tasks:
  - `AdminUser{id,email,passwordHash,name,role: AdminRole(SUPER_ADMIN|EVALUATOR),active,failedLoginCount,lockedUntil,lastLoginAt}`
  - `JobRole{id,name@unique,refApplicantCount,active}`
  - `ExamSetting{jobRoleId@unique,durationMinutes@default(60),windowStart?,windowEnd?,instructions,isOpen@default(false),questionsLocked@default(false)}`
  - `Question{id,jobRoleId,text,normalizedTextHash,maxMarks Decimal(6,1),evaluatorGuidance?,displayOrder,active}` with `@@unique([jobRoleId,normalizedTextHash])`
  - `ImportBatch{id,kind(CANDIDATES|QUESTIONS),jobRoleId?,fileName,fileHash,uploadedById,total,imported,skipped,errors Json}`
  - `Candidate{id,candidateCode@unique,fullName,email@unique,mobile?@unique,rollNumber?,xPercentage Decimal?,xiiPercentage Decimal?,majorCpi Decimal?,discipline?,programme?,extra Json,jobRoleId,eligible@default(true),locationExempt@default(false),status: CandidateStatus,importBatchId?}`
  - `CandidateStatus = NOT_STARTED|IN_PROGRESS|SUBMITTED|AUTO_SUBMITTED|EVALUATED|SHORTLISTED|REJECTED`
  - `ExamAttempt{id,candidateId,status: AttemptStatus(IN_PROGRESS|SUBMITTED|AUTO_SUBMITTED|RESET),startedAt,endsAt,submittedAt?,submitType?(MANUAL|AUTO),activeSessionId,startIp,userAgent,totalMarks Decimal?,maxMarks Decimal,percentage Decimal?}`. The migration adds a partial unique index on `exam_attempts(candidate_id) WHERE status <> 'RESET'`, as raw SQL appended to the migration and documented in the schema header comment.
  - `AttemptQuestion{id,attemptId,questionId,order,textSnapshot,maxMarksSnapshot}`
  - `Answer{id,attemptQuestionId@unique,text,wordCount,clientSeq Int,lastSavedAt,markedForReview,visited,bulkInsertFlags Int@default(0)}`
  - `AnswerVersion{id,answerId,text,wordCount,savedAt}`
  - `ActivityLog{id,candidateId,attemptId?,eventType: String,questionId?,ip,sessionId?,userAgent?,metadata Json,createdAt}`
  - `CandidateLoginLog{id,candidateId,stage(LOGIN|EXAM_START),permission(GRANTED|DENIED|UNAVAILABLE|TIMEOUT|UNSUPPORTED),latitude Decimal(9,6)?,longitude Decimal(9,6)?,accuracyM Int?,ip,userAgent,browser,os,deviceType,sessionFamily String?,createdAt}`
  - `QuestionEvaluation{attemptQuestionId@unique,marks Decimal(6,1),comment?,evaluatorId}`
  - `AttemptEvaluation{attemptId@unique,status(DRAFT|SUBMITTED),evaluatorId?,lockedById?,lockedAt?,submittedAt?}`
  - `CandidateStatusHistory{candidateId,fromStatus,toStatus,byAdminId?,comment?}`
  - `SystemConfig{key@unique,value Json,isSecret,updatedById?}`
  - `AdminAuditLog{adminId?,action,entity,entityId?,metadata Json,ip?,createdAt}`
  - Every table has a UUID PK, `createdAt`/`updatedAt` where mutable, FKs with `onDelete: Restrict` (Cascade only for AnswerVersion → Answer), and indexes on `candidates(job_role_id,status)`, `activity_logs(attempt_id,created_at)`, `candidate_login_logs(candidate_id,created_at)`, `candidate_login_logs(ip)`.
  - `seedData` exported from `seed.ts`: the 7 roles with their reference counts from design §4; system config keys `sms.arihant` and `email.zatpatmail`, both `{enabled:false,…defaults}`; one Super Admin from env (bcrypt cost 12, skipped if it already exists). With `SEED_DEMO=true`: 3 candidates + 2 questions on "Backend Engineer". The seed is idempotent (upserts).
- Consumes: `env` (Task 1).

- [ ] **Step 1: Write the failing test** `seed.data.test.ts`:
  - `seedData.roles.length === 7`
  - the reference counts sum to `461`
  - the role names match design §4 exactly
  - the config keys are `['sms.arihant','email.zatpatmail']`, both with `enabled:false`
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, `prisma.ts` (PrismaClient with `PrismaPg` adapter, as in the CRM) and `seed.ts`. Generate the migration SQL with `migrate diff` (no DB). Append the partial unique index.
- [ ] **Step 4: Run** `pnpm --filter @exam/api exec prisma validate && pnpm --filter @exam/api exec prisma generate && pnpm --filter @exam/api test`. Expected: PASS.
- [ ] **Step 5: Pause.** Hand the user these commands:
  - `createdb exam_db && createdb exam_test`
  - `cd exam/apps/api && cp .env.example .env.local` (then fill it in)
  - `pnpm migrate && pnpm seed`
  - `APP_ENV=test pnpm migrate` (needs `.env.test` pointing at `exam_test`)

---

### Task 3: Encrypted system config, SMS/email clients, Integrations API

**Files:**
- Create: `src/infrastructure/crypto/secretBox.ts`, `src/modules/systemConfig/{index,systemConfig.repository,systemConfig.service}.ts`, `src/modules/messaging/{index,sms.client,email.client,messaging.config}.ts`, `src/modules/integrations/{index,integrations.routes,integrations.controller,integrations.service,integrations.schemas}.ts`, `packages/shared/src/schemas/integrations.ts`
- Test: `tests/secretBox.test.ts`, `tests/messaging.clients.test.ts`, `tests/integrations.service.test.ts`

**Interfaces:**
- Consumes: `prisma`, `env`, `AppError`, `logger`, `maskEmail/maskMobile`.
- Produces:
  - `seal(plain: string): string` (`v1:<iv b64>:<tag b64>:<ct b64>`) and `open(sealed: string): string`.
  - `getConfig<T>(key): Promise<T>` (60 s in-memory cache) and `setConfig(key, value, adminId)`, which invalidates the cache. Secret fields are listed per key in `SECRET_FIELDS = { 'sms.arihant': ['authToken','apiKey'], 'email.zatpatmail': ['sendMailToken'] }`; they are sealed on write and opened on read.
  - `SmsConfig{enabled,baseUrl,authToken,userName,apiKey,otpTemplate}` with default `otpTemplate: 'Your Arihant Capital assessment OTP is {otp}. Valid for 5 minutes.'`
  - `EmailConfig{enabled,baseUrl,sendMailToken,fromAddress,fromName,replyTo}`
  - `sendSms({to, message}): Promise<void>` and `sendEmail({to, subject, html, text}): Promise<void>`. Both throw `MessagingError(code, retryable)`.
  - Port the request and auth-header logic from the CRM's `apps/backend/src/modules/sms/sms.client.ts` and `email/email.client.ts`: `Basic` prefix stripping, the `C-enczapikey` scheme, 15 s timeout, `track_opens/clicks:false`, no body/token logging.
  - `isChannelReady(cfg): boolean`: enabled and every required field non-blank.
  - Routes (Super Admin only; mounted in Task 5 once auth exists, until then the router is exported but not mounted):
    - `GET /api/admin/integrations` → `{ sms: MaskedSmsConfig, email: MaskedEmailConfig }`. Each secret field comes back as `{ set: boolean, last4: string|null }` and is never returned in full.
    - `PUT /api/admin/integrations/sms` and `/email`. A secret field omitted or sent as `null` keeps the stored value.
    - `POST /api/admin/integrations/sms/test {mobile}` and `/email/test {email}` → `{ delivered: true }`, or a 502 carrying the provider's error message.

- [ ] **Step 1: Write the failing tests**
  - `secretBox`: the round-trip works; tampering with any segment throws; two seals of the same text differ.
  - `messaging.clients`, with a local `https.createServer` using a self-signed cert (`NODE_TLS_REJECT_UNAUTHORIZED` set **only inside the test**) or with `https.request` stubbed via `mock.method`:
    - the SMS body equals `[{UserName:'u',APIkey:'k',SMSType:'OTP',messages:[{To:'919876543210',msg:'hi'}]}]`
    - the auth header is `Basic abc`, both for `abc` and for `Basic abc` as input
    - email: `Authorization: C-enczapikey tok` for both `tok` and `C-enczapikey tok`
    - a 4xx throws `MessagingError` with `retryable:false`
  - `integrations.service` (fake repository):
    - GET never contains the plaintext secret
    - a PUT without `authToken` keeps the old sealed value
    - `isChannelReady({enabled:true,userName:''…})===false`
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Every PUT and every test-send writes an audit entry via `audit.record`. `audit.record` is created in Task 5; for now, inject it as a function parameter of the service so Task 5 can wire it.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Pause.**

---

### Task 4: OTP service with static-OTP rule and delivery

**Files:**
- Create: `src/infrastructure/redis/redis.ts`, `src/shared/utils/hash.ts`, `src/modules/otp/{index,otp.service}.ts`, `src/modules/messaging/otpDelivery.service.ts`
- Test: `tests/otp.service.test.ts`, `tests/otpDelivery.test.ts`

**Interfaces:**
- Consumes: `getConfig`, `isChannelReady`, `sendSms`, `sendEmail`, `env.ALLOW_STATIC_OTP`.
- Produces:
  - `sha256(s)` and `safeEqual(a, b)` (timing-safe).
  - `OtpPurpose = 'admin_login' | 'candidate_login'`.
  - `issueOtp({purpose, subjectId, recipient:{email, mobile|null}}): Promise<{ deliveredVia: ('sms'|'email')[]; static: boolean }>`.
    - Redis key `otp:{purpose}:{subjectId}` holds `{hash, attempts}`, with TTL 300.
    - Cooldown key `otp:cd:{purpose}:{subjectId}` (TTL 60) → `OTP_COOLDOWN`.
  - `verifyOtp({purpose, subjectId, code}): Promise<void>`. It throws `OTP_EXPIRED` (no key), `OTP_INVALID` (wrong code; attempts incremented) or `OTP_LOCKED` (attempts ≥ 5; key deleted), and deletes the key on success.
  - `decideOtpMode({smsReady, emailReady, allowStatic, recipient}): 'static' | 'send' | 'unconfigured' | 'no_channel_for_recipient'`. This is the pure rule from design §7.2:
    - no channel ready and `allowStatic` → `static`
    - no channel ready and not `allowStatic` → `unconfigured`
    - some channel ready, but none of the recipient's channels is ready → `no_channel_for_recipient`
    - otherwise `send`
  - `deliverOtp(code, recipient, purpose)`: sends on each ready channel in parallel and succeeds if **either** delivers; otherwise it throws `OTP_DELIVERY_FAILED`. The email copy is built from the CRM's `buildOtpEmail`, with the code in the body only.

- [ ] **Step 1: Write the failing tests**
  - `decideOtpMode`, the full table:
    - `{false,false,true,{email,mobile:null}}` → `static`
    - `{false,false,false,…}` → `unconfigured`
    - `{true,false,true,{mobile:null}}` → `no_channel_for_recipient`
    - `{false,true,true,{email}}` → `send`
  - `otp.service`, using `ioredis-mock` as a dev dependency:
    - in static mode, `verifyOtp` accepts `'123456'`
    - a second `issueOtp` within 60 s throws `OTP_COOLDOWN`
    - 5 wrong codes, then the right code, throws `OTP_LOCKED`
    - an expired key throws `OTP_EXPIRED`
    - after success the same code throws `OTP_EXPIRED`
    - the Redis value never contains the plain code
  - `otpDelivery`:
    - SMS rejects and email resolves → resolves with `['email']`
    - both reject → throws `OTP_DELIVERY_FAILED`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Codes come from `crypto.randomInt(0, 1_000_000)`, zero-padded to 6 digits.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Pause.**

---

### Task 5: Admin auth, RBAC, audit log, admin users, break-glass CLI

**Files:**
- Create: `src/modules/audit/{index,audit.service,audit.repository,audit.routes}.ts`
- Create: `src/modules/adminAuth/{index,adminAuth.routes,adminAuth.controller,adminAuth.service,adminAuth.schemas,tokens}.ts`
- Create: `src/shared/middleware/{authenticateAdmin,authorize,rateLimit}.ts`
- Create: `src/modules/adminUsers/*`
- Create: `src/scripts/{disable-integrations,reset-admin-password}.ts`
- Modify: `src/router.ts` (mount auth, admin users, integrations, audit)
- Modify: `apps/api/package.json` scripts `admin:disable-integrations`, `admin:reset-password`
- Test: `tests/adminAuth.service.test.ts`, `tests/tokens.test.ts`, `tests/integration/adminAuth.int.test.ts`

**Interfaces:**
- Consumes: `issueOtp`, `verifyOtp`, `prisma`, `setConfig`.
- Produces:
  - `audit.record({adminId|null, action, entity, entityId?, metadata?, ip?})`. It is append-only: the repository exposes `create` and `list` only.
  - `signAccess(kind: 'admin'|'candidate', payload): string`. The JWT has `aud` set to `kind`, 15 min expiry, and uses the per-kind secret.
  - `verifyAccess(kind, token)`.
  - Refresh tokens: a random 32-byte token, sha256 stored in Redis at `rt:{kind}:{hash}` → `{subjectId, family}` with TTL 7 d (admin) or 12 h (candidate). Rotation replaces it, and reusing a rotated token revokes the whole family.
  - Cookies: admin `exam_admin_at` / `exam_admin_rt` (path `/api/admin`); candidate `exam_cand_at` / `exam_cand_rt` (path `/api/candidate`). All are `httpOnly`, `sameSite:'strict'`, with `secure: env.COOKIE_SECURE`.
  - Endpoints:
    - `POST /api/admin/auth/login {email,password}` → `{ otpRequired: true, challengeId }`. Generic `UNAUTHORIZED` on a wrong email or password. `ACCOUNT_LOCKED` after 5 failures (sets `lockedUntil` +15 min).
    - `POST /api/admin/auth/verify-otp {challengeId, code}` → sets the cookies and returns `{ admin: {id,name,email,role} }`. `challengeId` is a Redis key with a 5 min TTL mapping to `adminId`.
    - `POST /api/admin/auth/refresh`, `POST /api/admin/auth/logout`, `GET /api/admin/auth/me`.
  - `authenticateAdmin` sets `req.admin = {id, role}`. `authorize(...roles: AdminRole[])` returns 403 `FORBIDDEN` and audits `PERMISSION_DENIED`.
  - Admin users (Super Admin): `GET/POST /api/admin/users`, `PATCH /api/admin/users/:id` (name, role, active, reset password). A Super Admin cannot deactivate themselves or demote the last active Super Admin (`CONFLICT`).
  - `GET /api/admin/audit?entity&adminId&from&to&page` (Super Admin).
  - CLI: `pnpm --filter @exam/api admin:disable-integrations` sets `enabled:false` on both config keys. `admin:reset-password <email>` prompts for a password on stdin with no echo, and clears the lockout.
  - Rate limits (Redis store), keyed by IP + email: `adminLogin` 10/15 min.
  - All auth events are audited: `ADMIN_LOGIN_SUCCESS`, `ADMIN_LOGIN_FAILED`, `ADMIN_LOCKED`, `ADMIN_LOGOUT`, `ADMIN_OTP_FAILED`.

- [ ] **Step 1: Write the failing tests**
  - `tokens`:
    - a candidate token fails `verifyAccess('admin', …)`
    - rotation returns a new token, and the old one then fails
    - reusing an old token revokes the new one too
  - `adminAuth.service` (fake repository):
    - the 5th wrong password sets `lockedUntil ≈ now+15min` and throws `ACCOUNT_LOCKED`
    - a correct password while locked still throws `ACCOUNT_LOCKED`
    - success resets `failedLoginCount`
    - a wrong email and a wrong password produce the identical error code and message
  - `adminAuth.int` (supertest against `exam_test`, seeded with one admin; static OTP):
    - login → verify `123456` → `/me` is 200
    - an EVALUATOR calling `GET /api/admin/users` gets 403
    - no cookie → 401
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Mount the integrations router (Task 3) behind `authenticateAdmin, authorize('SUPER_ADMIN')` and wire `audit.record` into it.
- [ ] **Step 4: Run** `pnpm --filter @exam/api test && pnpm --filter @exam/api test:int`. Add the `test:int` script: `APP_ENV=test node --import tsx --test --test-concurrency=1 "tests/integration/*.int.test.ts"`. Each test file truncates its tables in `before()`. Expected: PASS. If `exam_test` isn't migrated yet, stop and ask the user to run the Task 2 commands.
- [ ] **Step 5: Pause.**

---

### Task 6: Candidate auth, device parsing and location capture

**Files:**
- Create: `src/modules/candidateAuth/{index,candidateAuth.routes,candidateAuth.controller,candidateAuth.service,candidateAuth.schemas}.ts`, `src/shared/middleware/authenticateCandidate.ts`, `src/shared/utils/{clientInfo,geo}.ts`, `packages/shared/src/schemas/auth.ts`
- Test: `tests/clientInfo.test.ts`, `tests/geo.test.ts`, `tests/integration/candidateAuth.int.test.ts`

**Interfaces:**
- Consumes: `issueOtp`, `verifyOtp`, tokens (Task 5), `prisma`.
- Produces:
  - `clientInfo(req): { ip, userAgent, browser, os, deviceType: 'desktop'|'mobile'|'tablet'|'unknown' }` using `ua-parser-js`, with `ip = req.ip` (trust proxy).
  - `haversineMeters(a: {lat, lng}, b: {lat, lng}): number`.
  - `POST /api/candidate/auth/request-otp {identifier}`. The identifier is an email or a 10-digit mobile (zod union). It **always** returns 200 `{ sent: true }`, whether or not the candidate exists, is eligible or is inactive. The OTP is only issued for an eligible match. `OTP_COOLDOWN` (429) **is** surfaced, because it reveals nothing beyond what was already typed. `OTP_DELIVERY_UNCONFIGURED`, `no_channel_for_recipient` and delivery failures are logged and audited, but the candidate still gets the generic 200. HR sees them in the activity log.
  - `POST /api/candidate/auth/verify-otp {identifier, code}` → sets the cookies and returns `{ candidate: CandidateSelf }`, then logs `OTP_VERIFIED`. A wrong identifier, wrong code, or non-eligible candidate all give `OTP_INVALID`.
  - `CandidateSelf = {id, candidateCode, fullName, email, jobRole:{id,name}, status, locationCaptured: boolean, locationExempt}`.
  - `POST /api/candidate/auth/refresh`, `/logout`, `GET /api/candidate/me`.
  - `POST /api/candidate/location {stage:'LOGIN'|'EXAM_START', permission, latitude?, longitude?, accuracyM?}`. It writes a `CandidateLoginLog` with `clientInfo` and an activity event (`LOCATION_CAPTURED` or `LOCATION_DENIED` / `LOCATION_UNAVAILABLE` / `LOCATION_TIMEOUT`). `latitude` must be in -90..90 and `longitude` in -180..180, and both are required when `permission === 'GRANTED'`. `locationCaptured` is true when a GRANTED `LOGIN` row exists with `sessionFamily` equal to the current refresh-token family, so every new login asks again.
  - `authenticateCandidate` sets `req.candidate = {id, sessionFamily}`. Every candidate repository call takes `candidateId` from here, never from the URL.
  - Rate limits: `request-otp` 5/10 min per identifier and 30/10 min per IP; `verify-otp` 10/10 min per IP.

- [ ] **Step 1: Write the failing tests**
  - `clientInfo`: an iPhone Safari UA gives `deviceType:'mobile'` and `os:'iOS'`; a Windows Chrome UA gives `desktop`.
  - `geo`: `haversineMeters({lat:26.1445,lng:91.7362},{lat:26.1445,lng:91.7362})===0`, and Guwahati→Delhi `{28.6139,77.209}` is within 1,438 km ± 5 km.
  - `candidateAuth.int`:
    - an unknown email still gets 200 `{sent:true}`, and no Redis key is created
    - a known email → verify `123456` → `/me` returns `locationCaptured:false`
    - POST location GRANTED → `/me` returns `locationCaptured:true`
    - a candidate access cookie sent to `/api/admin/auth/me` gets 401
    - GRANTED without a latitude gets 400
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit and integration tests. Expected: PASS.
- [ ] **Step 5: Pause.**

---

### Task 7: Job roles and exam settings

**Files:**
- Create: `src/modules/jobRoles/*`, `packages/shared/src/schemas/roles.ts`
- Test: `tests/integration/jobRoles.int.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/admin/roles` (any admin) → `[{id,name,refApplicantCount,active,settings:ExamSettingDto,counts:{questions,candidates}}]`
  - `POST /api/admin/roles`, `PATCH /api/admin/roles/:id` (Super Admin)
  - `PUT /api/admin/roles/:id/settings {durationMinutes 10..240, windowStart?, windowEnd?, instructions ≤ 10000, isOpen}` (Super Admin; `windowEnd > windowStart` when both are set; audited)
  - Internal `jobRoles.getSettings(jobRoleId)`, used by Task 10.
  - `examAvailability(settings, now): 'OPEN' | 'NOT_OPEN' | 'BEFORE_WINDOW' | 'AFTER_WINDOW'`. This pure function lives in `packages/shared/src/examAvailability.ts` so the web app can use it too.
- [ ] **Step 1: Write the failing tests**
  - `examAvailability` (unit, in shared): `isOpen:false` → `NOT_OPEN`; now < start → `BEFORE_WINDOW`; now > end → `AFTER_WINDOW`; no window → `OPEN`.
  - Integration: an Evaluator PUT settings gets 403; a PUT with `durationMinutes: 5` gets 400.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run.** PASS.
- [ ] **Step 5: Pause.**

---

### Task 8: Questions: CRUD, lock and CSV/XLSX import

**Files:**
- Create: `src/shared/utils/spreadsheet.ts`, `src/modules/questions/{index,questions.routes,questions.controller,questions.service,questions.repository,questionImport.parser,questions.schemas}.ts`, `packages/shared/src/schemas/questions.ts`
- Test: `tests/spreadsheet.test.ts`, `tests/questionImport.parser.test.ts`, `tests/integration/questions.int.test.ts`

**Interfaces:**
- Produces:
  - `readSheet(buffer, fileName): Promise<{ headers: string[]; rows: Record<string, string>[] }>`.
    - `.csv` goes through `csv-parse` (`bom:true`, `trim:true`, `skip_empty_lines:true`); `.xlsx` goes through `exceljs` (first sheet).
    - Headers are lower-cased and trimmed.
    - Cells are stringified: integers without a decimal point; floats rounded to 6 significant digits, so `97.6000001` → `"97.6"`.
    - At most **5,000** rows and **50** columns (`VALIDATION_ERROR` beyond that).
    - Anything other than `.csv` or `.xlsx` → 400.
  - Upload middleware: `multer.memoryStorage()`, 5 MB limit, extension + MIME allow-list.
  - `normalizeQuestionText(t)`: trims, collapses whitespace, lower-cases. Its `sha256` is `normalizedTextHash`.
  - Template columns: `question_text, max_marks, evaluator_guidance, display_order`. `GET /api/admin/questions/template.csv` serves the template.
  - `parseQuestionRows(rows, existingHashes: Set<string>): { valid: QuestionDraft[]; errors: {row:number; field:string; message:string}[]; duplicates: {row:number; reason:'IN_FILE'|'EXISTS'}[] }`.
    - Row numbers are 1-based and count the header row (as in Excel), so data starts at 2.
    - `max_marks` must be a number 0.5..100 in 0.5 steps.
    - `question_text` length must be 10..5000.
  - Import endpoints:
    - `POST /api/admin/questions/import/preview` (multipart `file`, `jobRoleId`) → `{ previewId, fileHash, summary:{total,valid,errors,duplicates}, valid, errors, duplicates }`. The parsed result is cached in Redis for 30 min under `import:{previewId}`.
    - `POST /api/admin/questions/import/confirm {previewId}` inserts the valid rows in one transaction and writes an `ImportBatch`. If the same `fileHash` was confirmed for the same role before, the response is `CONFLICT` with "This file was already imported on <date>", unless `{force:true}` is sent.
  - CRUD:
    - `GET /api/admin/questions?jobRoleId` (Evaluators also get it; guidance included).
    - `POST`, `PATCH /:id`, `PATCH /:id/active`, `PATCH /api/admin/roles/:id/questions/order {ids[]}`.
    - Every write checks `ExamSetting.questionsLocked` → `QUESTIONS_LOCKED` (423).
    - `POST /api/admin/roles/:id/questions/unlock {reason}` (Super Admin; audited `QUESTIONS_UNLOCKED`; sets `questionsLocked=false`).
    - Task 10 sets `questionsLocked=true` on the first start.
  - Candidate endpoints never touch this module directly. Questions reach candidates only through `AttemptQuestion` snapshots (Task 10).
- [ ] **Step 1: Write the failing tests**
  - `spreadsheet`:
    - a CSV with BOM and `" Question_Text "` header gives the header `question_text`
    - an xlsx built in-test with exceljs, holding the numeric cell `254101009`, gives `"254101009"`
    - `97.6000001` gives `"97.6"`
    - trailing empty rows are dropped
    - 5,001 rows throw
  - `questionImport.parser`:
    - two identical texts differing only in case and whitespace → the second is a duplicate `IN_FILE` at row 3
    - a text whose hash is in `existingHashes` → `EXISTS`
    - `max_marks: '7.3'` → error `{row:2, field:'max_marks'}`
  - `questions.int`:
    - preview → confirm inserts N rows
    - confirming the same file again → 409
    - after setting `questionsLocked=true`, PATCH returns 423
    - unlock as an Evaluator → 403
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run.** PASS.
- [ ] **Step 5: Pause.**

---

### Task 9: Candidates: import, list, detail, edit, eligibility, exemption, reset

**Files:**
- Create: `src/modules/candidates/{index,candidates.routes,candidates.controller,candidates.service,candidates.repository,candidateImport.parser,candidateCode,candidates.schemas}.ts`, `packages/shared/src/schemas/candidates.ts`
- Test: `tests/candidateImport.parser.test.ts`, `tests/candidateCode.test.ts`, `tests/integration/candidates.int.test.ts`

**Interfaces:**
- Consumes: `readSheet`, the upload middleware, the Redis preview cache pattern (Task 8), `audit.record`.
- Produces:
  - `HEADER_MAP`:
    - `name` → `fullName`
    - `email` → `email`
    - `mobile` → `mobile`
    - `roll_number` → `rollNumber`
    - `schooling.x_percentage` → `xPercentage`
    - `schooling.xii_percentage` → `xiiPercentage`
    - `major_cpi` → `majorCpi`
    - `major.discipline` → `discipline`
    - `major.programme` → `programme`
    - `job_role` → `jobRoleName`
    - every other header → `extra[header]`
  - `parseCandidateRows(rows, ctx:{ defaultJobRoleId, rolesByLowerName: Map, existingEmails: Set, existingMobiles: Set }): { valid, errors, duplicates }`. Rules:
    - name 2..150, required
    - email valid, required, lower-cased
    - mobile optional: strip a leading `+91`/`91`/`0`, then it must be 10 digits starting 6–9
    - percentages 0..100; CPI 0..10
    - a `job_role` naming no known role is an error
    - duplicates are checked on email and on mobile, both within the file and against the DB
  - `nextCandidateCodes(n): Promise<string[]>` uses a Postgres sequence `candidate_code_seq` (create it in a new migration `<ts>_candidate_code_seq`) and formats `ARH-EX-` + 6 zero-padded digits.
  - Import endpoints:
    - `POST /api/admin/candidates/import/preview` (multipart `file`, `jobRoleId`)
    - `POST /api/admin/candidates/import/confirm {previewId}`
    - `GET /api/admin/candidates/template.csv` (the HR header row from design §6.1 + `mobile`, `job_role`)
  - `GET /api/admin/candidates?search&jobRoleId&status&flagged&sort(fullName|majorCpi|xPercentage|xiiPercentage|createdAt)&dir&page&pageSize(≤100)` (Super Admin) → paginated rows. Each row includes `flagCount` (integrity + location flags, from Task 10's `flags` view; return `0` until Task 10 lands).
  - `GET /api/admin/candidates/:id` (Super Admin) → profile, extra, login/location logs, attempt summary, activity log (paged), status history.
  - `PATCH /api/admin/candidates/:id` edits fields. A `jobRoleId` change is only allowed while `status==='NOT_STARTED'`, else `ROLE_CHANGE_FORBIDDEN`.
  - `PATCH /:id/eligibility {eligible}` and `PATCH /:id/location-exempt {exempt, reason}`.
  - `POST /:id/reset-attempt {reason (min 10)}` sets the attempt status to `RESET`, the candidate status to `NOT_STARTED`, and writes history. It runs in a transaction and is audited.
  - Every write is audited, and the Super Admin is required on all of these routes.
- [ ] **Step 1: Write the failing tests**
  - `candidateImport.parser`, using the user's sample row (`97.6, 99.8, 254101009, AJITH K K, 8.67, Computer Science and Engineering, M.Tech, k.ajith@iitg.ac.in`), which must map exactly to `{fullName:'AJITH K K', email:'k.ajith@iitg.ac.in', rollNumber:'254101009', xPercentage:97.6, xiiPercentage:99.8, majorCpi:8.67, discipline:'Computer Science and Engineering', programme:'M.Tech', jobRoleId: default, mobile:null, extra:{}}`. Also:
    - `K.Ajith@IITG.ac.in` repeated → `IN_FILE` duplicate
    - `mobile:'+91 98765 43210'` → `'9876543210'`
    - `major_cpi:'11'` → an error on `major_cpi`
    - `job_role:'Unknown'` → an error on `job_role`
    - an unknown header `hostel` → `extra.hostel`
  - `candidateCode`: formatting `7` gives `ARH-EX-000007`.
  - `candidates.int`:
    - import 3 → list total 3
    - a role change after start → `ROLE_CHANGE_FORBIDDEN`
    - reset → a new attempt can be created (the partial unique index allows it)
    - an Evaluator calling list → 403
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run.** PASS.
- [ ] **Step 5: Pause.** Hand over the new migration command.

---

### Task 10: Exam engine: start, state, autosave, integrity, events, submit, auto-submit, location flags

**Files:**
- Create: `src/modules/exam/{index,exam.routes,exam.controller,exam.service,exam.repository,integrity,locationFlags,exam.schemas}.ts`
- Create: `src/infrastructure/queue/{autoSubmit.queue,autoSubmit.worker,sweep}.ts`
- Create: `packages/shared/src/schemas/exam.ts`
- Modify: `src/index.ts` (start the worker and a 60 s sweep interval)
- Test: `tests/integrity.test.ts`, `tests/locationFlags.test.ts`, `tests/integration/exam.int.test.ts`

**Interfaces:**
- Consumes: `authenticateCandidate`, `examAvailability`, `getSettings`, `clientInfo`, `haversineMeters`, `countWords`.
- Produces:
  - `POST /api/candidate/exam/start {location: LocationPayload}`. Checks, in order:
    - candidate eligible, else `FORBIDDEN`
    - availability `OPEN`, else `EXAM_NOT_OPEN` / `EXAM_WINDOW_CLOSED`
    - a GRANTED location in the payload unless `locationExempt`, else `LOCATION_REQUIRED` (the `EXAM_START` login-log row is written either way)
    - no non-RESET attempt, else return the existing one (idempotent resume) or, if it's submitted, `ALREADY_ATTEMPTED`

    In one transaction it then:
    - creates the attempt with `endsAt = startedAt + durationMinutes`
    - snapshots the active questions into `AttemptQuestion`
    - creates an empty `Answer` for each
    - sets `questionsLocked=true` on the role and the candidate to `IN_PROGRESS` (with history)
    - generates a new `activeSessionId` (uuid)

    It then enqueues `autoSubmit` with delay `endsAt + 10 s − now` and jobId `attempt:{id}`, and logs `EXAM_STARTED`. It returns `ExamState`.
  - `GET /api/candidate/exam` → `ExamState = {attemptId, sessionId?, status, serverNow, startedAt, endsAt, durationMinutes, questions:[{attemptQuestionId, order, text, maxMarks, answer:{text, wordCount, clientSeq, markedForReview, visited, lastSavedAt}}]}`. Evaluator guidance is never included. `sessionId` is returned only by start/resume.
  - `POST /api/candidate/exam/resume` → issues a new `activeSessionId`, logs `SESSION_TAKEOVER`, and returns `ExamState`.
  - `PUT /api/candidate/exam/answers/:attemptQuestionId {sessionId, clientSeq, text ≤ 20000 chars, typedChars ≥ 0, intervalMs ≥ 0, markedForReview?, visited?}`. Checks:
    - the attempt question belongs to the token's candidate, else 404
    - the attempt is `IN_PROGRESS`, else `ATTEMPT_LOCKED`
    - `now ≤ endsAt + 10 s`, else `ATTEMPT_LOCKED`
    - `sessionId === activeSessionId`, else 409 `SESSION_SUPERSEDED`
    - `clientSeq > stored`, else 200 `{ accepted:false, reason:'STALE' }` and nothing is written

    It then runs `assessSave` and, when flagged, increments `bulkInsertFlags` and logs `SUSPICIOUS_BULK_INSERT` with `{grown, typed, rate}`. It updates the answer and adds an `AnswerVersion` if the last version is ≥ 30 s old. It returns `{ accepted:true, serverNow, lastSavedAt }`.
  - The save endpoint also accepts `text/plain` beacons: `POST /api/candidate/exam/answers/:id/beacon` with a JSON string body. This is for `sendBeacon` on `pagehide`, using the same logic.
  - `assessSave({prevLength, newLength, typedChars, intervalMs}): { flagged: boolean; reasons: ('GROWTH_EXCEEDS_TYPED'|'TYPING_RATE')[]; grown: number; rate: number }`:
    - `grown = newLength − prevLength`
    - `GROWTH_EXCEEDS_TYPED` when `grown > typedChars + 50`
    - `TYPING_RATE` when `intervalMs ≥ 1000` and `typedChars / (intervalMs/1000) > 15`
  - `POST /api/candidate/exam/events {sessionId, events:[{type, questionId?, at, metadata?}] (≤ 50)}`.
    - Allowed types: `QUESTION_VIEWED, PASTE_ATTEMPT, COPY_ATTEMPT, CUT_ATTEMPT, DROP_ATTEMPT, CONTEXT_MENU, TAB_HIDDEN, TAB_VISIBLE, WINDOW_BLUR, WINDOW_FOCUS, PAGE_UNLOAD, NETWORK_OFFLINE, NETWORK_ONLINE`.
    - The server stamps its own `createdAt` and keeps the client `at` in metadata.
    - The server also logs `IP_CHANGED` when `req.ip` differs from the last logged IP for the attempt.
  - `POST /api/candidate/exam/submit {sessionId}` → `SUBMITTED`; candidate `SUBMITTED`; history; removes the BullMQ job; logs `EXAM_SUBMITTED`.
  - `autoSubmitAttempt(attemptId)` is idempotent: it only acts when the status is `IN_PROGRESS` and `now ≥ endsAt`. It sets `AUTO_SUBMITTED` / `submitType AUTO`, updates the candidate, and logs `EXAM_AUTO_SUBMITTED`. The worker and `sweepExpiredAttempts()` (attempts `IN_PROGRESS` with `endsAt + 10 s < now`) both call it.
  - `computeLocationFlags(candidateId)` → `[{code:'LOGIN_START_DISTANCE', km}|{code:'NEARBY_CANDIDATES', withCandidateIds, meters}|{code:'SHARED_IP', ip, count}]`.
    - The nearby check considers only `EXAM_START` rows within ±2 h of this candidate's start.
    - The shared-IP check counts distinct candidates with an `EXAM_START` row from the same IP.
    - It is exposed internally as `exam.getFlags(candidateId) → { integrity: {pasteAttempts, bulkInsert, tabHidden, blur, ipChanges}, location: [...] }`, consumed by Tasks 9 (wire `flagCount`) and 11.
  - Answers after submit are rejected by the `IN_PROGRESS` check, so locking needs no extra code.
- [ ] **Step 1: Write the failing tests**
  - `integrity`:
    - `assessSave({0, 600, 0, 3000})` → flagged `GROWTH_EXCEEDS_TYPED`
    - `({0, 60, 40, 3000})` → not flagged
    - `({100, 160, 60, 2000})` → `TYPING_RATE` (30/s)
    - `({100, 80, 0, 2000})` → not flagged (deletion)
  - `locationFlags` (pure helper `evaluateLocationFlags(own, others, ipCounts, thresholds)`):
    - login→start 60 km → `LOGIN_START_DISTANCE`
    - two starts 40 m apart → `NEARBY_CANDIDATES`
    - 3 candidates on the same IP → `SHARED_IP`
    - 2 → none
  - `exam.int` (seed a role with 2 questions, duration 1 min, one candidate, static OTP):
    - start without location → `LOCATION_REQUIRED`
    - start with location → state with 2 questions and no `evaluatorGuidance` key anywhere
    - `saveAnswer ignores lower clientSeq`: save seq 2 `'bb'`, then seq 1 `'a'` → stored `'bb'`
    - `rejects foreign session` → 409
    - `resume issues new session, same endsAt`
    - starting twice → the same attemptId
    - another candidate's `attemptQuestionId` → 404
    - `rejects after grace`: set `endsAt` to the past via prisma → `ATTEMPT_LOCKED`, and the stored text is unchanged
    - `sweep auto-submits expired in-progress attempts` (no queue) → `AUTO_SUBMITTED`
    - manual submit, then save → `ATTEMPT_LOCKED`
    - the first start sets `questionsLocked`
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.** BullMQ uses the `REDIS_URL` connection with `maxRetriesPerRequest:null`. The worker concurrency is 5.
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Pause.**

---

### Task 11: Evaluation (blind), decisions, leaderboard, dashboard and exports

**Files:**
- Create: `src/modules/evaluation/{index,evaluation.routes,evaluation.controller,evaluation.service,evaluation.repository,evaluation.mapper,evaluation.schemas}.ts`
- Create: `src/modules/results/{index,results.routes,results.controller,results.service,exports}.ts`, `src/shared/utils/csvEscape.ts`, `packages/shared/src/schemas/evaluation.ts`
- Test: `tests/evaluation.mapper.test.ts`, `tests/marks.test.ts`, `tests/csvEscape.test.ts`, `tests/integration/evaluation.int.test.ts`

**Interfaces:**
- Consumes: `exam.getFlags`, `authorize`, `audit.record`.
- Produces:
  - `toSubmissionView(row, viewerRole)`:
    - for an `EVALUATOR`: `{attemptId, candidateCode, jobRole, submittedAt, timeTakenSec, submitType, flagCounts, evaluationStatus, totalMarks?}`
    - for a `SUPER_ADMIN`: the same plus `{candidateId, fullName, email, rollNumber, majorCpi, xPercentage, xiiPercentage, programme, discipline}`
  - `toMarkingView(attempt, viewerRole)`:
    - every question gets `{attemptQuestionId, order, text, maxMarks, evaluatorGuidance (live from Question), answer:{text, wordCount, versions:[{savedAt, wordCount}]}, integrity:{pasteAttempts, bulkInsert:[{at, grown, typed}]}, evaluation:{marks, comment}}`
    - PII is added only for a Super Admin
    - location is **never** included
  - Endpoints:
    - `GET /api/admin/submissions?jobRoleId&evaluation(PENDING|DRAFT|SUBMITTED)&search(candidateCode, or also name for SA)&page` (Evaluator + SA).
    - `POST /api/admin/submissions/:attemptId/lock` → soft lock for 30 min. It returns `{lockedBy:{id,name}, lockedAt}`; if someone else holds an unexpired lock, `EVALUATION_LOCKED` 423 with the holder's name. `DELETE …/lock` releases it.
    - `PUT /api/admin/submissions/:attemptId/evaluation {items:[{attemptQuestionId, marks, comment?}], submit: boolean}`. It requires holding the lock. `validateMarks(marks, max)` rejects `<0`, `>max` or not a multiple of 0.5 → `MARKS_OUT_OF_RANGE` with `{attemptQuestionId}`. `submit:true` needs every question marked, then computes `totalMarks`, `maxMarks`, `percentage = round(total/max*100, 2)`, sets the candidate to `EVALUATED` (history), and is audited.
    - `POST /api/admin/submissions/:attemptId/reopen {reason}` (SA) → back to `DRAFT`; the candidate goes back to the previous submitted status.
    - `POST /api/admin/candidates/:id/decision {decision:'SHORTLISTED'|'REJECTED', comment?}` (SA; only from `EVALUATED`/`SHORTLISTED`/`REJECTED`) → history + audit.
    - `GET /api/admin/leaderboard?jobRoleId` (SA) → evaluated candidates sorted by `totalMarks desc, submittedAt asc`, with rank, PII, per-question marks and flag counts.
    - `GET /api/admin/dashboard` (any admin; Evaluators get counts only) → per role `{refApplicantCount, imported, notStarted, inProgress, submitted, autoSubmitted, evaluated, shortlisted, rejected, pendingEvaluation}`.
    - `GET /api/admin/exports/results.xlsx?jobRoleId?` (SA) → one sheet per role, with candidate fields, per-question marks, total, %, status, flag counts and evaluator comments.
    - `GET /api/admin/exports/activity.xlsx?jobRoleId?` (SA) → integrity + location flags.
  - `csvEscape(v)`: a string starting with `= + - @ \t \r` gets a `'` prefix. It's applied to every string cell in exports.
- [ ] **Step 1: Write the failing tests**
  - `evaluation.mapper`, `evaluator payload has no PII keys`: a deep scan of `toSubmissionView` and `toMarkingView` for EVALUATOR finds none of the keys `fullName, email, mobile, rollNumber, majorCpi, xPercentage, xiiPercentage, programme, discipline, latitude, longitude, ip, candidateId`. For SA, `fullName` is present and `latitude` is absent.
  - `marks`: `validateMarks(7.5,10)` ok; `(10.5,10)`, `(-1,10)` and `(3.3,10)` throw; the percentage of 37.5/50 is `75`.
  - `csvEscape`: `'=SUM(A1)'` → `"'=SUM(A1)"`; `'Ajith'` unchanged.
  - `evaluation.int`:
    - evaluator A locks; evaluator B's lock attempt → 423 naming A
    - submit with a missing question → 400
    - submit complete → candidate `EVALUATED`
    - an Evaluator calling decision → 403
    - the leaderboard order with ties is by `submittedAt`
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run.** PASS.
- [ ] **Step 5: Pause.**

---

### Task 12: Web scaffold, theme, shared UI, API client, auth stores and route guards

**Files:**
- Create: `apps/web/{package.json,vite.config.ts,tsconfig.json,tailwind.config.ts,postcss.config.js,index.html}`, `src/{main.tsx,App.tsx,index.css}`, `src/lib/{api.ts,utils.ts,serverClock.ts}`, `src/stores/{adminAuth,candidateAuth}.ts`, `src/components/ui/*`, `src/components/auth/{AuthPageShell,OtpForm}.tsx`, `src/components/layout/{AdminLayout,AdminRoute,CandidateRoute}.tsx`, `public/*`
- Copy (byte-for-byte, then adapt the copy text):
  - `inhousecrm/apps/web/src/index.css` (theme tokens, `.glass`, `animate-fade-in`)
  - `tailwind.config.*`
  - `public/{logo-light.svg,logo-dark.svg,favicon.svg}`
  - `components/ui/{button,input,label,card,table,dialog,select,badge,textarea,dropdown-menu,tooltip,pagination,confirm-dialog,checkbox,popover,table-header-filter,clear-filters-button,separator}.tsx`
  - `components/auth/AuthPageShell.tsx`: the subtitle becomes "Recruitment Assessment"; drop `NetworkBlockedNotice`.
- Test: `apps/web/tests/serverClock.test.ts`, `apps/web/tests/api.test.ts`

**Interfaces:**
- Consumes: API contracts from Tasks 5–11, and `@exam/shared` types.
- Produces:
  - `apiFetch<T>(area: 'admin'|'candidate', path, init?): Promise<T>`. It sends `credentials:'include'` and unwraps `{success,data}`. On a 401 it calls `/api/{area}/auth/refresh` once and retries; if that fails, it clears the store and redirects to `/admin/login` or `/login`. It throws `ApiError{status, code, message}`.
  - `createServerClock(serverNowIso, receivedAtMs = Date.now())` → `{ now(): number; remainingMs(endsAtIso): number }`, where `now() = serverNow + (nowFn() − receivedAt)` and `nowFn` defaults to `Date.now` (injectable for tests). `remainingMs` never goes below 0.
  - Stores: `useAdminAuth {admin|null, setAdmin, clear}` and `useCandidateAuth {candidate|null, setCandidate, clear}` (Zustand; nothing sensitive persisted, rehydrated via `/me`).
  - Routing: `/login`, `/location`, `/dashboard`, `/exam`, `/submitted` (candidate, inside `<CandidateRoute>`); `/admin/login`, and `/admin/*` inside `<AdminRoute roles>` + `AdminLayout`. Admin pages are `React.lazy`-loaded, so the candidate bundle doesn't include them.
  - `AdminLayout` is modelled on the CRM's `DashboardLayout` sidebar, with the items from design §12 filtered by role. Evaluators see Dashboard and Submissions only.
  - Vite dev: port 5174 with `server.proxy['/api'] = 'http://localhost:4100'`.
  - `OtpForm`: 6 inputs with auto-advance and paste allowed here (the login form, not the exam), a resend button that shows the cooldown countdown, and the static-OTP hint is **not** shown.
- [ ] **Step 1: Write the failing tests** (`node:test` + `tsx`, pure functions):
  - `serverClock`: with `serverNow = T` and the local clock 5 min ahead, `remainingMs(T+60s)` ≈ 60 s ± 50 ms (use `mock.timers` / an injected `nowFn`); after `endsAt` it returns `0`.
  - `api`: a 401 → refresh → retry succeeds (mock `fetch`); a refresh failure → `ApiError` with code `UNAUTHORIZED`.
- [ ] **Step 2: Run** `pnpm --filter @exam/web test`. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm --filter @exam/web check-types` and `pnpm --filter @exam/web build`. PASS, build OK.
- [ ] **Step 5: Pause.**

---

### Task 13: Admin pages: login, dashboard, admin users, integrations, audit log

**Files:**
- Create: `src/pages/admin/{Login,Dashboard,AdminUsers,Integrations,AuditLog}.tsx`, `src/api/admin/{auth,users,integrations,audit,dashboard}.ts` (TanStack Query hooks)

**Interfaces:**
- Consumes: the Task 12 primitives; the Task 5, 3 and 11 endpoints.
- Behaviour pinned by the spec:
  - **Login**: `AuthPageShell` → email + password (RHF + zod) → `OtpForm` step. It shows `ACCOUNT_LOCKED` as "Too many attempts — try again in 15 minutes".
  - **Integrations**: two cards (SMS, Email), each with an enable switch and the fields from design §10. A secret input shows "•••• 1234 (saved)" with a **Replace** button, and an empty value keeps the saved one. Each card has a **Send test** dialog.
    - A warning banner appears when SMS is enabled and email is disabled while any candidate lacks a mobile. This needs a count from `GET /api/admin/integrations` → add `candidatesWithoutMobile` to that response, in Task 3's service.
    - A note reminds the user to set `ALLOW_STATIC_OTP=false` before the live exam.
  - **Dashboard**: one card per role with the counts.
  - **Admin users**: a table plus create/edit dialogs.
  - **Audit log**: a table with header filters (the CRM's column-filter pattern).
- [ ] **Step 1: Write the failing test** `tests/integrationsForm.test.ts` for the pure helper `buildIntegrationPatch(form, saved)`: an untouched secret is omitted; a replaced secret is included; whitespace is trimmed.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement** the pages and the helper. **Step 4: Run** the tests + `check-types` + `build`. PASS.
- [ ] **Step 5: Pause.** Ask the user to click through `/admin/login` on their running dev servers. Static OTP `123456`.

---

### Task 14: Admin pages: roles and settings, questions, candidates (with import wizard)

**Files:**
- Create: `src/components/import/ImportWizard.tsx`, `src/pages/admin/{Roles,Questions,Candidates,CandidateDetail}.tsx`, `src/api/admin/{roles,questions,candidates}.ts`

**Interfaces:**
- `ImportWizard` props: `{ kind:'CANDIDATES'|'QUESTIONS', jobRoles, templateUrl, previewFn, confirmFn }`. Steps:
  1. choose a role and a file
  2. preview: tabs for Valid / Errors (row, field, message) / Duplicates (row, reason), plus summary chips
  3. confirm (on 409 "already imported", offer "Import anyway")
  4. a summary showing imported / skipped
- **Roles**: a table of roles and an edit-settings dialog (duration, window start/end as datetime-local, shown in IST, instructions textarea, open switch).
- **Questions**: a role selector, an ordered list with drag reorder (`@dnd-kit` as in the CRM), add/edit dialog, an active toggle, and a lock banner with **Unlock** (SA) asking for a reason.
- **Candidates**: a table with header filters (role, status, flagged) and sortable academic columns; a row links to detail.
- **Candidate detail**: tabs for Profile (editable) · Login & location (each log row with an OpenStreetMap link `https://www.openstreetmap.org/?mlat=..&mlon=..`, accuracy, IP, device) · Activity · Flags · History. Actions: eligibility toggle, location-exempt (reason), reset attempt (reason, confirm dialog). The approximate-location disclaimer from design §7.2a is shown.
- [ ] **Step 1: Write the failing test** `tests/importWizard.state.test.ts` for the pure reducer `importReducer(state, action)`: `PREVIEW_OK` moves to `preview`; `CONFIRM_CONFLICT` sets `canForce:true`; `CONFIRM_OK` moves to `done` with counts.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run** the tests + `check-types` + `build`. PASS.
- [ ] **Step 5: Pause.** Ask the user to import the sample candidate row and 2 questions through the UI.

---

### Task 15: Candidate login, location gate and dashboard

**Files:**
- Create: `src/lib/{geolocation,browserInfo}.ts`, `src/components/location/{LocationGate,LocationHelp}.tsx`, `src/pages/candidate/{Login,Location,Dashboard}.tsx`, `src/api/candidate/{auth,location}.ts`
- Test: `tests/geolocation.test.ts`, `tests/browserInfo.test.ts`

**Interfaces:**
- Produces:
  - `requestLocation(opts = {timeoutMs: 15000}): Promise<LocationResult>`, where `LocationResult = {permission:'GRANTED', latitude, longitude, accuracyM} | {permission:'DENIED'|'UNAVAILABLE'|'TIMEOUT'|'UNSUPPORTED'}`. It maps the `GeolocationPositionError` codes 1/2/3, and `!('geolocation' in navigator) || !isSecureContext` gives `UNSUPPORTED`. It uses `enableHighAccuracy:true, maximumAge:0`.
  - `watchPermission(onChange): () => void`, wrapping `navigator.permissions.query({name:'geolocation'})` and `onchange`. It is a no-op where unsupported (older Safari).
  - `detectBrowser(ua): 'chrome'|'edge'|'firefox'|'safari-mac'|'safari-ios'|'chrome-android'|'other'` and `detectOs(ua): 'windows'|'macos'|'android'|'ios'|'other'`, which drive `LocationHelp`'s step lists (copy from design §7.2a).
- Behaviour:
  - **Login**: `AuthPageShell` with "Email or mobile number", then `OtpForm`. The response after requesting an OTP is always "If you're registered, a code has been sent." After a successful verify → `/location`.
  - **Location**: the explainer card and **Allow location**, then the state table from design §7.2a (prompt / denied / unavailable / timeout / unsupported) with the matching alert colour, help steps and **Try again**. A timeout retries once automatically. `watchPermission` re-runs capture when the permission turns `granted`. Every result is POSTed to `/api/candidate/location` with stage `LOGIN`. On GRANTED it shows a confirm panel (approximate area to 3 decimals, accuracy, IP, device from `/me`), then **Continue** → `/dashboard`. **Skip for now** → `/dashboard`, where Start stays disabled.
  - **Dashboard**:
    - shows name, candidate code, role, duration, window (IST), instructions (rendered as plain text with line breaks), and the rules panel
    - shows the location banner while `!locationCaptured && !locationExempt`
    - the "I have read the instructions" checkbox
    - **Start Examination** is disabled with a tooltip reason, based on `examAvailability` and location
    - clicking Start calls `requestLocation()` again, then `POST /exam/start` with it; `LOCATION_REQUIRED` re-opens the location alert inline
    - **Resume** when `IN_PROGRESS`
    - submitted → `/submitted`
- [ ] **Step 1: Write the failing tests**
  - `geolocation`, with a stubbed `navigator`: error code 1 → `DENIED`, 2 → `UNAVAILABLE`, 3 → `TIMEOUT`; no geolocation → `UNSUPPORTED`; success maps the coords and rounds accuracy.
  - `browserInfo`: real UA strings for Edge on Windows → `edge`/`windows`, iPhone Safari → `safari-ios`/`ios`, Samsung Chrome → `chrome-android`/`android`.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run** the tests + `check-types` + `build`. PASS.
- [ ] **Step 5: Pause.** Ask the user to test in Chrome: allow, block, then unblock via the lock icon, and confirm it auto-continues.

---

### Task 16: Exam screen: paste guard, autosave, timer, palette, submit

**Files:**
- Create: `src/lib/{pasteGuard,autosave}.ts`, `src/components/exam/{ExamHeader,QuestionPalette,AnswerBox,SaveStatus,SubmitDialog}.tsx`, `src/pages/candidate/{Exam,Submitted}.tsx`, `src/api/candidate/exam.ts`
- Test: `tests/pasteGuard.test.ts`, `tests/autosave.test.ts`

**Interfaces:**
- Consumes: `createServerClock`, `countWords`, the Task 10 endpoints.
- Produces:
  - `isBlockedKey(e: {key, ctrlKey, metaKey, shiftKey}): 'PASTE'|'COPY'|'CUT'|null` covers Ctrl/Cmd+V/C/X and Shift+Insert (→ `PASTE`).
  - `isBlockedInputType(t: string): boolean` is true for `insertFromPaste`, `insertFromPasteAsQuotation`, `insertFromDrop`, `insertReplacementText`, `insertFromYank`.
  - `isTypedInputType(t)` is true for `insertText`, `insertLineBreak`, `insertParagraph`, `insertCompositionText`. It is used to count `typedChars`; for `insertCompositionText`, count only the final committed data length.
  - `attachPasteGuard(textarea, onBlocked(kind))` binds `paste, copy, cut, drop, dragover, contextmenu, keydown, beforeinput` and returns a detach function.
  - `createAutosaver({ save(payload): Promise<SaveResult>, debounceMs: 2000, storage: Storage, key(attemptQuestionId) })` → `{ update(id, text, typedDelta), flush(id?), flushBeacon(), status$: subscribe((s: 'saved'|'saving'|'offline'|'error'|'superseded'|'locked') => void) }`. Rules:
    - it keeps `clientSeq` per question, incremented on every send
    - it mirrors unsent text to storage under `exam:{attemptId}:{aqId}` and clears it on an accepted save
    - it retries with backoff 1, 2, 4, 8, 15 s (capped at 15 s, retrying forever) while status is `offline`
    - `SESSION_SUPERSEDED` → `superseded`, stop
    - `ATTEMPT_LOCKED` → `locked`, stop
    - `{accepted:false, reason:'STALE'}` counts as saved
    - `typedChars` and `intervalMs` are accumulated since the last accepted save; on failure they carry over to the next send
  - On mount, a localStorage mirror that's newer than the server copy (by length and timestamp) is restored into the box and saved immediately.
- Screen behaviour:
  - Light theme is forced; no sidebar.
  - **Header**: name, code, role, a countdown (`mm:ss`; amber under 10 min, red under 2 min), and `SaveStatus`. The countdown re-syncs from `serverNow` on every save response and every 60 s via `GET /exam`.
  - **Palette** states: not visited / visited-unanswered / answered (wordCount > 0) / marked for review / current.
  - **AnswerBox**: a `<textarea>` with `spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off"` and the live word count "N words · target 1,000–1,500", amber above 1,500. A toast on a blocked action reads "Pasting, copying and dragging text are disabled during the exam. This attempt has been recorded."
  - **Events** are batched and flushed every 5 s and on `pagehide` (beacon): `QUESTION_VIEWED`, blocked actions, `visibilitychange`, `blur/focus`, `online/offline`, `pagehide`.
  - `beforeunload` shows the browser's leave prompt while status ≠ `saved`.
  - **Superseded**: a full-screen notice, "This exam is open in another window", with **Continue here** (→ `POST /exam/resume`).
  - **Time-up**: when `remainingMs` hits 0, flush, then show "Time is up — your answers have been submitted", then → `/submitted`.
  - **Submit dialog**: lists unanswered and marked-for-review counts, and requires typing nothing extra, just a confirm.
  - `/submitted`: "Your exam has been submitted. Thank you." Nothing else, and no marks.
- [ ] **Step 1: Write the failing tests**
  - `pasteGuard`:
    - `{key:'v', ctrlKey:true}` → `PASTE`
    - `{key:'V', metaKey:true}` → `PASTE`
    - `{key:'Insert', shiftKey:true}` → `PASTE`
    - `{key:'c', ctrlKey:true}` → `COPY`
    - `{key:'a', ctrlKey:true}` → `null` (select-all allowed)
    - `isBlockedInputType('insertFromDrop')` → true
    - `isTypedInputType('insertText')` → true
  - `autosave` (fake timers, fake `save`, in-memory Storage):
    - 3 updates within 2 s → 1 save with `clientSeq` 1
    - `save` rejecting with a network error → status `offline`, the storage mirror is present, and the retry after 1 s succeeds → `saved` with the mirror cleared
    - `SESSION_SUPERSEDED` → `superseded`, and further updates don't call `save`
    - `typedChars` carries over after a failed save
    - `flush()` sends immediately
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run** the tests + `check-types` + `build`. PASS.
- [ ] **Step 5: Pause.** Ask the user to run a manual exam with a 10-minute duration and check:
  - Ctrl+V, right-click and drag are all blocked
  - refresh keeps the text and the time
  - switching Wi-Fi off and on shows "Offline", then "Saved"
  - a second tab gets the superseded notice
  - letting the timer run out auto-submits

---

### Task 17: Admin pages: submissions, marking, leaderboard and decisions

**Files:**
- Create: `src/pages/admin/{Submissions,Marking,Leaderboard}.tsx`, `src/api/admin/{evaluation,results}.ts`

**Interfaces:**
- Consumes: the Task 11 endpoints.
- Behaviour:
  - **Submissions**: a table with role, evaluation status and search filters, and flag-count badges. For an Evaluator it has no name column, because the API doesn't send one.
  - **Marking**:
    - opening it calls lock; a 423 shows "Being marked by <name>" read-only
    - one panel per question: question text, a guidance callout, the answer in a read-only scrollable box (`whitespace-pre-wrap`, with copy allowed for the admin), word count, integrity flags (paste attempts, bulk inserts with time/grown/typed), a version timeline (word count over time as a small list), and a marks input (step 0.5, max shown) plus a comment
    - sticky footer: running total, **Save draft**, **Submit evaluation** (disabled until every question has marks), and lock release on unmount
    - a Super Admin also sees the candidate panel (name and academics) and a **Reopen** button
  - **Leaderboard** (SA): role tabs, the ranked table, **Shortlist** / **Reject** actions with a comment dialog, and **Export XLSX** buttons (results and activity).
- [ ] **Step 1: Write the failing test** `tests/marking.test.ts` for the pure helpers `canSubmitEvaluation(items)` (false if any marks are null) and `sumMarks(items)` (`[7.5, 10, null]` → 17.5).
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement.** **Step 4: Run** the tests + `check-types` + `build`. PASS.
- [ ] **Step 5: Pause.** Ask the user to mark the attempt from Task 16 as an Evaluator, then shortlist as Super Admin, then export.

---

### Task 18: Deployment files and README

**Files:**
- Create: `apps/api/Dockerfile`, `.dockerignore`, `deploy/{docker-compose.prod.yml, deploy-api.sh, deploy-web.sh, backup-db.sh, nginx/exam.conf, .env.production.example}`, `apps/web/.env.production.example` (if needed)
- Create: `apps/api/src/scripts/purge-candidates.ts` (the anonymise script from deployment §10, `--before <date> --yes`)
- Modify: `README.md` (local setup, tests, deploying, go-live checklist; condensed from `deployment.md`)
- Test: `tests/purgeCandidates.test.ts` (pure `anonymizeCandidate(row)` → fullName `Anonymised`, email `anon+<id>@invalid`, mobile/rollNumber/academics/extra cleared, `candidateCode` and marks kept)

**Interfaces:**
- Values copied verbatim from `deployment.md`:
  - containers `exam_api`, `exam_postgres`, `exam_redis`; network `exam_net`
  - API bound to `127.0.0.1:4100`; Redis with `requirepass`; no published DB/Redis ports
  - nginx: `large_client_header_buffers 4 16k`, `client_max_body_size 6m`, `Permissions-Policy: geolocation=(self)`, HSTS, `try_files $uri /index.html`, `limit_req` on `/api/candidate/auth/`, forwarded headers set
  - `deploy-api.sh <uat|production> [--migrate] [--image tag]`: no `git pull`; fails if the env file is missing or contains `<`/`changeme`; tags `exam-api:<timestamp>` and keeps the last 3; waits up to 60 s on `/health`
  - `deploy-web.sh <uat|production>`: `pnpm install --filter @exam/web... --frozen-lockfile`, build, `rsync -a --delete dist/` to `/var/www/<domain>` (the domain comes from the `EXAM_WEB_DOMAIN` variable in the env file)
  - `backup-db.sh`: `docker exec exam_postgres pg_dump | gzip`, 14-day retention
  - The Dockerfile follows the CRM's multi-stage pattern (node:24-alpine, non-root uid 1001, curl HEALTHCHECK `/health`, prod-only reinstall) but with `exam/` as the build context. The seed is compiled into `dist/` so `node dist/infrastructure/db/seed.js` works.
- [ ] **Step 1: Write the failing test** `purgeCandidates.test.ts`.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement** the script and every deploy file. Shell scripts get `set -euo pipefail` and are `chmod +x`.
- [ ] **Step 4: Verify:**
  - `pnpm --filter @exam/api test` passes
  - `bash -n deploy/*.sh` has no syntax errors
  - `docker build -f apps/api/Dockerfile -t exam-api:check .`, run from `exam/`, succeeds (if Docker is available locally; otherwise say so)
  - `docker compose -f deploy/docker-compose.prod.yml config` validates
  - `nginx -t -c` isn't possible without the certs, so show the user the file
- [ ] **Step 5: Final verification**, reporting each result: `pnpm -r check-types`, `pnpm -r test`, `pnpm --filter @exam/api test:int`, `pnpm --filter @exam/web build`, and `grep -rn "inhousecrm\|@repo/\|\.\./\.\./apps" exam --include=*.ts --include=*.tsx --include=*.json -l`, which must return nothing (the standalone check).
- [ ] **Step 6: Pause.** Summarise everything and hand over the full list of commands the user must run (DB creation, migrations, seed, env fill-in).
