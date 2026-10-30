# Arihant Recruitment Exam — Design (v1)

Date: 2026-10-31
Status: draft, awaiting approval

## 1. Intent

Arihant is hiring for seven roles (~461 applicants, mostly campus candidates, e.g. IIT Guwahati M.Tech). HR wants every applicant to sit a timed, **written** exam for the role they applied to, and then have Arihant staff read and mark the answers by hand.

The exam is not a quiz. Every question asks for a descriptive answer of roughly 1,000–1,500 words. The real value is a fair, comparable piece of the candidate's own writing. Two things therefore matter most:

1. **The answer must be the candidate's own typing.** Paste into the answer box is blocked, and every attempt is recorded. (Browser blocks are a deterrent, not a guarantee; the server-side evidence in §7.4 is what an evaluator should trust.)
2. **No candidate loses work or time to the platform.** Answers autosave to the server. The timer is server-owned and survives refresh, disconnect and closing the browser.

## 2. Project shape

- A **standalone project** that lives in `exam/` for now. The user will move it out of the CRM repo and set it up as its own repo. It must therefore have **no imports, symlinks, relative paths or workspace links** into the CRM. Anything borrowed (theme tokens, logos, UI components, SMS/email client logic) is **copied in**.
- The CRM (`apps/backend`, `apps/web`) is a **reference only**: for UI look and feel, the login screen pattern, and how the SMS gateway and ZatpatMail are called. It is not touched.
- Layout: a pnpm workspace.

  ```
  exam/
  ├── apps/
  │   ├── api/        Express + TypeScript + Prisma
  │   └── web/        React 19 + Vite + TS + Tailwind + shadcn/ui
  ├── packages/
  │   └── shared/     shared TS types + zod schemas used by both apps
  ├── docs/
  ├── package.json, pnpm-workspace.yaml
  └── README.md       setup: create DB, env, migrate, seed, run
  ```

- Stack (mirrors the CRM so the user knows it): Node/TS/Express, Prisma ORM on PostgreSQL, Redis (OTP rate limits, sessions, BullMQ for the auto-submit sweep), JWT auth. Frontend: React 19, Vite, React Router, Tailwind, shadcn/ui (Radix), TanStack Query, Zustand, React Hook Form + Zod.
- **Deployment-ready without deployment work** *(builder's call)*: settings for `TRUST_PROXY`, `COOKIE_SECURE`, `CORS_ORIGIN` and `PUBLIC_WEB_URL` come from env. Admin and candidate are served from one origin under `/admin/*` and `/*`, with separate cookie names. The design assumes all 461 candidates may sit at the same time: ~1 autosave every 2 s each is well under 300 req/s, so a single API process is fine.
- Local defaults: DB `exam_db` on the same Postgres server the user already runs, Redis on default port, API on **4100**, web on **5174**. Deployment: see `docs/deployment.md`.
- The user applies migrations and seeds themselves. The builder supplies the commands and does not run them.

## 3. Users and roles

| Role | Logs in with | Can do |
|---|---|---|
| **Super Admin** | email + password, then OTP | everything: roles, questions, candidates, exam settings, integrations, admin users, marking, shortlist/reject |
| **Evaluator** | email + password, then OTP | read submitted attempts and award marks + comments; nothing else |
| **Candidate** | email (or mobile, if on file) + OTP | only their own exam |

RBAC is a simple fixed role enum on the admin user, enforced by middleware on every admin route. There is no role/permission editor in v1. Candidate tokens are a separate token type. Candidate tokens are rejected by every admin route, and admin tokens are rejected by candidate exam routes.

The seed creates one Super Admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `exam/apps/api/.env`.

## 4. Job roles

Seed these 7 (name, plus reference applicant count shown on the dashboard only):

| Job role | Ref. applicants |
|---|---:|
| AI Product Manager - Trading & Wealth | 33 |
| Product Management | 118 |
| Customer Data Analytics & Engagement Specialist (CleverTap) | 16 |
| Data Science / ML Engineer | 106 |
| Backend Engineer | 36 |
| Algo & Quant Profile | 42 |
| AI & ML Engineer | 110 |

The Super Admin can add, rename and deactivate roles. Each role carries its own **exam settings**:

- duration in minutes (default **60**)
- optional start/end window: a candidate can only **start** inside it; once started, they get their full duration even past the window end
- instructions text shown before Start
- whether the exam is open (a master switch per role)

Every candidate belongs to exactly one role and only ever sees that role's questions.

## 5. Questions

- **Descriptive only.** No MCQ, no auto-marking, no code editor.
- Fields: role, question text (multi-line plain text), max marks, optional evaluator guidance (never sent to candidates), display order, active/inactive.
- Added on the admin dashboard either **one at a time** (form) or by **CSV/XLSX upload** for a role. Upload flow: download template → upload → server parses and validates → preview with row-level errors → confirm → import summary. Duplicate detection is by identical normalised text within the same role: duplicates are flagged in the preview and skipped.
- **Every active question of the role is given to every candidate of that role, in display order.** (60 minutes realistically fits 2–3 such questions; that is HR's call when they author them.)
- **Locked once the role's exam has begun** *(builder's call)*: as soon as any candidate of a role has started, that role's questions can no longer be added, edited, deactivated or re-imported, so every candidate of the role sits the same paper. The question page shows the lock. A Super Admin can **unlock** it, after a confirm warning that candidates will no longer be comparable. The unlock is audit-logged. Separately, each attempt stores a snapshot of question text and max marks, so even an unlocked edit never changes what an earlier candidate saw or how they're marked.

## 6. Candidates

### 6.1 Import

HR's real data looks like this (one row per candidate):

```
schooling.x_percentage | schooling.xii_percentage | roll_number | name | major_cpi | major.discipline | major.programme | email
97.6                   | 99.8                     | 254101009   | AJITH K K | 8.67 | Computer Science and Engineering | M.Tech | k.ajith@iitg.ac.in
```

- Upload CSV or XLSX on the admin dashboard. **The admin chooses the job role for the whole file** on the upload screen. An optional `job_role` column, if present, overrides it per row (it must match an existing role name).
- Header mapping (case-insensitive, dots kept as-is):
  - `name` → full name (required)
  - `email` → email (required, unique, lower-cased)
  - `mobile` → optional 10-digit Indian mobile (not in HR's sample, but supported)
  - `roll_number` → roll number (optional)
  - `schooling.x_percentage`, `schooling.xii_percentage` → decimals (optional)
  - `major_cpi` → decimal (optional)
  - `major.discipline`, `major.programme` → text (optional)
  - any other column → kept in an `extra` JSON field, shown on the candidate detail page
- A **candidate code** (e.g. `ARH-EX-000123`) is generated for every candidate. It is shown to them and on all admin screens.
- Same flow as questions: preview, row errors, duplicates (email already exists, or repeated within the file) flagged and skipped, confirm, summary. 461 rows is small: import runs synchronously in one transaction, so no background job is needed.

### 6.2 Management

Candidate list with search (name, email, roll number, candidate code), filter by role and by status, sort by academic fields. Candidate detail page: profile, attempt status, activity log, marks. Super Admin can edit details, change role (only before the candidate has started), and disable/enable eligibility. **Reset attempt** (lets a candidate retake) is Super Admin only, requires a reason and is audit-logged.

### 6.3 Status

`NOT_STARTED → IN_PROGRESS → SUBMITTED | AUTO_SUBMITTED → EVALUATED → SHORTLISTED | REJECTED`

The candidate only ever sees "Not started", "In progress" or "Submitted". Marks and the final decision are **never shown to the candidate**.

## 7. Candidate journey

### 7.1 Login (OTP)

1. Candidate enters their registered **email** (or mobile, if one is on file).
2. If no eligible candidate matches, the response is the same generic "If you're registered, a code has been sent" message. This prevents enumeration.
3. A 6-digit OTP is generated and stored **hashed in Redis**. It expires after 5 min, allows 5 wrong attempts, has a 60 s resend cooldown, and is invalidated on success. Rate limits apply per IP and per identifier.
4. It is sent to **every channel the candidate has** (email always; SMS if a mobile is on file). The flow succeeds if **either** delivers.
5. On success the candidate gets a JWT (httpOnly cookie) and lands on their dashboard.

### 7.2 Static OTP for testing (user requirement)

Until real credentials are entered in the admin Integrations page, OTPs are **not sent** and the code is always **`123456`**, for both candidates and admins:

- The rule is **system-wide** *(builder's call)*: if **no** channel (SMS or email) is configured and enabled for the whole system, the server stores the hash of `123456` instead of a random code and sends nothing.
- As soon as **any** channel is enabled, everyone gets real random OTPs on whichever of their channels are enabled. A recipient with no enabled channel (e.g. SMS-only is enabled and the candidate has no mobile) gets "We couldn't send your code — contact HR". They never fall back to `123456`. The Integrations page warns when the enabled channels don't cover every candidate (e.g. email disabled while some candidates have no mobile).
- *Builder's safety call:* an env flag `ALLOW_STATIC_OTP` (default `true` in `.env.example`) must also be true for the fallback to apply. With it false and no channel configured, login fails with "OTP delivery is not configured". The README tells the user to set it to `false` before the real exam, so a broken config can never silently let anyone in with `123456`.
- **Break-glass** *(builder's call)*: if a misconfigured channel locks admins out of the Integrations page, the CLI command `pnpm --filter api admin:disable-integrations` (run on the server) switches both channels off so the static fallback applies again. A second command, `admin:reset-password <email>`, covers a lost admin password. Neither command is exposed over HTTP.

### 7.2a Location at login (user requirement)

Immediately after a successful OTP, before the dashboard, the candidate sees a **"Share your location"** screen that explains why. It then calls `navigator.geolocation.getCurrentPosition` (high accuracy, 15 s timeout).

- **Stored per login** in `candidate_login_logs`: latitude, longitude, accuracy (m), permission result (GRANTED / DENIED / UNAVAILABLE / TIMEOUT), IP, user agent, parsed browser/OS/device type, and timestamp. The same capture runs again at **Start Examination**, so an admin can compare login and start locations.
- The candidate sees what was captured (approximate area, IP, device) and confirms.
- **If location is off or blocked** (user requirement: alert the candidate and ask again): the candidate **can log in and see the dashboard but cannot Start the exam** until location is shared. The screen reacts to *why* it failed:

  | Situation (how we detect it) | What the candidate sees |
  |---|---|
  | Not asked yet (`navigator.permissions` state `prompt`) | An explainer card ("We record your approximate location once at login and once at exam start…") with an **Allow location** button that triggers the browser's own permission popup. |
  | Blocked for this site (state `denied`, or error `PERMISSION_DENIED`) | A red alert: "Location is blocked for this site." Browsers don't let a page re-open a popup the user has blocked, so it shows **step-by-step instructions for their detected browser** (Chrome/Edge: lock icon → Site settings → Location → Allow; Firefox; Safari macOS/iOS; Chrome Android), plus a **Try again** button. |
  | Location turned off on the device (error `POSITION_UNAVAILABLE`) | An amber alert: "Your device's location service is off." Shows OS-specific steps (Windows Settings → Privacy → Location; macOS System Settings → Privacy → Location Services; Android/iOS quick settings) and **Try again**. |
  | Took too long (error `TIMEOUT`) | "Couldn't get your location — move near a window or turn on Wi-Fi", with automatic retry once, then **Try again**. |
  | Browser has no geolocation / not HTTPS | "This browser can't share location — please use the latest Chrome, Edge, Firefox or Safari." |

  - The page listens for permission changes (`permissionStatus.onchange`). When the candidate fixes it in the browser settings, capture runs automatically, with no reload needed.
  - On the dashboard, a persistent banner ("Location required to start your exam — Enable location") stays until location is captured. The **Start Examination** button stays disabled, with a tooltip saying why.
  - Clicking **Start** re-checks location. If it has since been turned off, the same alert appears instead of starting.
  - Every failed attempt is logged (`LOCATION_DENIED` / `LOCATION_UNAVAILABLE` / `LOCATION_TIMEOUT`), so HR can see who struggled.
  - A Super Admin can tick **"Exempt from location"** on a candidate (audit-logged) for genuine cases, e.g. a desktop with no location hardware.
- **Flags for HR review, never auto-disqualification:** the start location is more than 50 km from the login location; two or more candidates within 100 m of each other at start; 3 or more candidates starting from the same public IP. Thresholds are configurable constants. The flags appear on the candidate page and the submissions list.
- Honest limits are shown in the admin UI: laptop location usually comes from Wi-Fi/IP (20 m to several km), and it can be faked. Treat it as a signal, not proof.
- Location is personal data: it is shown only to Super Admin (never to Evaluators, in line with blind marking) and never written to application logs.
- Geolocation only works on **HTTPS** (or `localhost`), which is one more reason the deployment must be HTTPS.

### 7.3 Dashboard → Start

The dashboard shows name, candidate code, role, duration, exam window, the role's instructions, and a rules panel: no paste, activity is recorded, the timer keeps running if you close the tab, auto-submit at time-up. A checkbox "I have read the instructions" enables **Start Examination**. A candidate with an existing attempt sees **Resume** (if in progress) or "Submitted" (if done), never a second Start.

### 7.4 Exam screen

- **Header:** name, candidate code, role, server-synced countdown, save status ("Saved 3s ago" / "Saving…" / "Offline — will retry").
- **Question palette:** numbered chips showing not visited / visited-unanswered / answered / marked-for-review / current. Free navigation between questions.
- **Answer area:** large plain-text `<textarea>` (no rich text). It shows a **live word count** with the target "1,000–1,500 words". Above 1,500 the count turns amber; it is **not** a hard block.
- **Paste/copy prevention** (deterrent, on the answer box and the page):
  - block `paste`, `copy`, `cut`, `drop`, `dragover`, `contextmenu`, and `beforeinput` with `inputType` = `insertFromPaste` / `insertFromDrop` / `insertReplacementText`
  - block Ctrl/Cmd+V/C/X and Shift+Insert
  - `autocomplete`/`autocorrect`/`spellcheck` off
  - every blocked attempt is logged (`PASTE_ATTEMPT`, `COPY_ATTEMPT`, `DROP_ATTEMPT`) with the question, and a short toast tells the candidate it isn't allowed
- **Server-side evidence** (the part admins should trust): the client counts characters actually typed (`beforeinput` events of type `insertText`/`insertLineBreak`) since the last save and sends that count with every save. The server compares it with the answer's real growth. Two checks, either one flags the save `SUSPICIOUS_BULK_INSERT` on that question (the save is still accepted):
  - **growth vs typed:** the answer grew by more than **typed + 50 characters**. Text appeared that was not typed: paste, drop, autofill, or a script.
  - **typing rate:** typed characters over the save interval exceed **15 chars/second** (~180 wpm sustained). This catches a script that fakes input events.
  Evaluators see these flags, with the numbers, beside the answer. *(Builder's call: thresholds are configurable constants.)*
- **Also logged** (cheap, all deterrents): tab hidden/visible, window blur/focus, page unload/reload, network offline/online, IP change between saves. No GPS and no full-screen enforcement in v1.
- **Single session:** starting or resuming an attempt issues an attempt-session id. A save from any other session id is rejected with "This exam is open in another window". The candidate can take over from the new window, and the takeover is logged.

### 7.5 Autosave

- Debounced save (~2 s after typing stops), plus a save on question change, on `visibilitychange`, and on `pagehide` (via `sendBeacon`).
- Each save sends the full answer text plus a client sequence number. The server ignores out-of-order (older) saves.
- Failed saves retry with backoff. Unsaved text is also mirrored in `localStorage` so a crash/refresh restores it, then re-saves. The candidate is never silently left with unsaved work: the header shows it.
- Answer **version history** is kept: a version row at most every 30 s per question, plus the final one. Evaluators can see how an answer grew over time.

### 7.6 Timer and submit

- At Start the server records `startedAt` and `endsAt = startedAt + duration`. Every response carries `serverNow` and `endsAt`; the client counts down from that offset, never from its own clock.
- Saves after `endsAt` (plus a 10 s grace for in-flight requests) are rejected.
- **Manual submit:** confirm dialog → `SUBMITTED`, attempt locked.
- **Auto-submit:** a BullMQ delayed job fires at `endsAt + grace` and locks the attempt as `AUTO_SUBMITTED`. A periodic sweep (every minute) catches any attempt past `endsAt` that is still `IN_PROGRESS`, in case a job was lost. This works even if the candidate closed the browser.
- After submit the candidate sees "Your exam has been submitted. Thank you." and nothing else.

## 8. Marking (admin side)

- **Submissions list:** filter by role, status (pending / evaluated), search; columns for candidate, code, role, submitted at, time taken, flags count, total marks.
- **Marking screen:** one candidate at a time. Each question shows the question, evaluator guidance, the full answer, word count, and the paste/bulk-insert flags for that question. The evaluator enters marks (0…max, decimals to 0.5 allowed, server-enforced ≤ max) and a comment per question.
  - **Save draft** at any time.
  - **Submit evaluation** requires marks on every question. It sets status `EVALUATED` and computes total + percentage.
  - A submitted evaluation can be reopened by a Super Admin only (logged).
- **Blind marking** *(builder's call; the user asked for the security checks to stay)*: an **Evaluator** sees only the candidate code, the role, the questions, the answers, word counts and integrity flags. The API never returns name, email, mobile, roll number, institute or academic scores to the Evaluator role; this is enforced server-side in the response mapping, not by hiding columns in the UI. A **Super Admin** sees everything, including names alongside marks on the leaderboard and in exports.
- One evaluator per attempt at a time: the first to open it holds a soft lock that the screen shows to others, so two people don't mark the same script at once.
- **Decision:** the Super Admin marks `SHORTLISTED` or `REJECTED` with an optional internal comment. Status history is kept.
- **Ranking:** a per-role leaderboard sorted by total marks (ties broken by submit time). Exportable to XLSX along with candidate details, per-question marks and flag counts.

## 9. Admin dashboard (v1, small)

The home page shows per-role cards: applicants imported, not started, in progress, submitted, evaluated, shortlisted, plus reference applicant count. Charts and deeper analytics are out of scope.

## 10. Integrations (admin enters credentials)

An **Settings → Integrations** page, Super Admin only, modelled on the CRM's system-config approach (credentials in a DB `system_configs` key/value table, never in `.env`):

- **SMS (Arihant SMS gateway):** enabled, base URL (default `https://arihantapi.arihantcapital.com/V1/api/Media/sendSMS`), auth token (Basic; accepts with or without `Basic ` prefix), user name, API key, OTP message template text with a `{otp}` placeholder (must match the DLT-approved template). Request shape: `POST` JSON array `[{UserName, APIkey, SMSType:'OTP', messages:[{To:'91XXXXXXXXXX', msg}]}]`, `Authorization: Basic …`, as in the CRM's `sms.client.ts`.
- **Email (ZatpatMail):** enabled, base URL (default `https://api.zatpatmail.com`), send-mail token (accepts with or without the `C-enczapikey` scheme prefix, as in the CRM's `buildAuthHeader`), from address, from name, reply-to. Sends via `POST /v1.1/email` with subject + html/text body, `track_opens/clicks: false`.
- Secrets are **encrypted at rest** (AES-256-GCM with a key from `CONFIG_ENCRYPTION_KEY` env), shown masked after save, and never returned in full by the API.
- A **"Send test"** button per channel sends a test message to an address/number the admin types and reports success or the provider's error.
- Clients use Node's built-in `https` with a 15 s timeout, and never log OTPs, message bodies or tokens. Recipients are masked in logs.

## 11. Data model (Prisma, normalised)

Tables (snake_case in DB):

- `admin_users` (email, password_hash, name, role enum SUPER_ADMIN|EVALUATOR, active, last_login_at)
- `job_roles` (name unique, ref_applicant_count, active)
- `exam_settings` (1:1 job_role: duration_minutes, window_start, window_end, instructions, is_open)
- `questions` (job_role_id, text, normalized_text_hash, max_marks, evaluator_guidance, display_order, active) — unique (job_role_id, normalized_text_hash)
- `import_batches` (kind CANDIDATES|QUESTIONS, job_role_id, file_name, uploaded_by, total, imported, skipped, errors JSON, created_at)
- `candidates` (candidate_code unique, full_name, email unique, mobile nullable, roll_number, x_percentage, xii_percentage, major_cpi, discipline, programme, extra JSON, job_role_id, eligible, status enum, import_batch_id)
- `exam_attempts` (candidate_id **unique** in v1 → one attempt, unless reset; reset moves the old row to status RESET and keeps it, so the unique key is (candidate_id) where status ≠ RESET via partial index), started_at, ends_at, submitted_at, submit_type MANUAL|AUTO, active_session_id, start_ip, user_agent, total_marks, max_marks, percentage, status)
- `attempt_questions` (attempt_id, question_id, order, text_snapshot, max_marks_snapshot)
- `answers` (attempt_question_id unique, text, word_count, client_seq, last_saved_at, marked_for_review, visited)
- `answer_versions` (answer_id, text, word_count, saved_at)
- `candidate_login_logs` (candidate_id, stage LOGIN|EXAM_START, latitude, longitude, accuracy_m, permission, ip, user_agent, browser, os, device_type, created_at); `candidates` also gets `location_exempt` boolean
- `activity_logs` (attempt_id nullable, candidate_id, event_type, question_id nullable, ip, session_id, user_agent, metadata JSON, created_at). Append-only: the app has no update/delete path.
- `question_evaluations` (attempt_question_id unique, marks, comment, evaluator_id, updated_at)
- `attempt_evaluations` (attempt_id unique, status DRAFT|SUBMITTED, evaluator_id, locked_by, locked_at, submitted_at)
- `candidate_status_history` (candidate_id, from, to, by_admin_id, comment, created_at)
- `system_configs` (key unique, value JSON, is_secret, updated_by, updated_at)
- `admin_audit_logs` (admin_id, action, entity, entity_id, metadata JSON, ip, created_at)

All with UUID PKs, FKs, `created_at/updated_at`, and indexes on every list filter (role, status, email, candidate_code, attempt_id+created_at on logs).

**Migrations:** Prisma migrations under `apps/api/prisma/migrations`. **Seed:** 7 roles + default exam settings, the Super Admin from env, empty `system_configs` rows for SMS/email (disabled), and optionally (`SEED_DEMO=true`) 3 demo candidates + 2 demo questions for the Backend Engineer role.

## 12. UI and theme

- Copy from the CRM web app: the Arihant theme tokens (`index.css` `:root` / `.dark` HSL variables, `glass`, `animate-fade-in`), `tailwind.config`, the `logo-light.svg` / `logo-dark.svg` / favicon, and the shadcn `ui/` components needed (button, input, label, card, table, dialog, select, badge, textarea, dropdown-menu, tooltip, pagination, confirm-dialog).
- **Both login screens follow the CRM's `AuthPageShell`** (gradient orbs, grid backdrop, logo, glass card, SEBI footer). Copy changes: "Arihant Capital — Recruitment Assessment". The admin login is email+password then an OTP step. The candidate login is email/mobile then OTP.
- Admin pages use a sidebar layout like the CRM's `DashboardLayout`: Dashboard, Candidates, Questions, Exam Settings, Submissions/Marking, Leaderboard, Admin Users, Integrations, Audit log.
- Column filters live in the table header, the way the CRM does them.
- The candidate exam screen is minimal and distraction-free: no sidebar, light theme forced.

## 13. Engineering and security standards (same practices as the CRM)

**Backend structure**
- One folder per module under `apps/api/src/modules/<name>/`, each with `index.ts` (barrel), `*.routes.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `*.schemas.ts`. Other modules import only from the barrel.
- `infrastructure/` holds config, db (Prisma client), redis, queue, logger and crypto. `shared/` holds middleware and utils.
- All DB access goes through repositories, using Prisma. Any operation that touches more than one table runs in a transaction (import confirm, start attempt, submit, evaluation submit, status change).
- Env vars are validated with Zod at startup and the process stops on a missing value. `.env.example` is committed and `.env` is never committed.
- Every request body, query and param is validated with Zod at the controller. The shared schemas live in `packages/shared`.
- One response shape: `{ success: true, data }` / `{ success: false, error: { message, code } }`, produced by a central error handler. Stack traces are never sent to the client.
- File headers and comments explain *why*, in the CRM's style.

**Security**
- `helmet`, a strict CORS allow-list, `compression`, a body size limit, and `trust proxy` driven by env.
- Passwords are hashed with bcrypt (cost 12). OTPs and refresh tokens are stored only as SHA-256 hashes. Comparisons are constant-time.
- JWT access tokens are short-lived (15 min), with a rotating refresh token in an httpOnly, SameSite=Strict cookie (Secure when `COOKIE_SECURE`). Admin and candidate tokens use different secrets, audiences and cookie names, and logout revokes the refresh token.
- Redis-backed rate limits on OTP request/verify, admin login, autosave (generous) and uploads.
- Admin login: after 5 wrong passwords in a row the account is locked for 15 minutes, and the lockout is audit-logged.
- RBAC middleware (`authorize(SUPER_ADMIN)`) sits on every admin route. Candidate routes scope every query by the candidate id from the token, never by an id in the URL, so a candidate cannot reach another candidate's data (IDOR).
- Uploads: multer in memory, a 5 MB limit, an extension and MIME allow-list, and parsing with row/column caps. CSV cells starting with `= + - @` are escaped on **export** to block formula injection.
- Integration secrets are AES-256-GCM encrypted at rest, masked in API responses, and never logged.
- Logging: winston with daily rotation and request IDs. Emails/mobiles are masked in logs, and OTPs, answer text, passwords and tokens are never logged.
- Audit log (`admin_audit_logs`) for every admin write: imports, question edits/unlocks, settings, integrations, evaluations, status decisions, attempt resets, and all auth events (login success/failure, lockout, logout).
- `activity_logs` and `admin_audit_logs` are append-only: no update/delete in code, and the README documents an optional DB-level `REVOKE UPDATE, DELETE`.

**Frontend**
- One `apiFetch()` wrapper handles credentials, the 401 → refresh → retry flow, and the error shape.
- Server data comes through TanStack Query and auth state through Zustand. Every form uses React Hook Form with a Zod resolver, reusing the shared schemas.
- Route guards are split into `<AdminRoute roles=[…]>` and `<CandidateRoute>`. Pages lazy-load by area, so the candidate bundle never contains admin code.

**Testing**
- `node:test` + `tsx`, like the CRM. Unit tests cover the import parsers/validators, the OTP rules (including the static-OTP rule), the bulk-insert detection, timer/deadline maths and marks validation.
- Integration tests run against a separate `exam_test` database and cover: login → start → save → submit; auto-submit; saves rejected after the deadline; a second session rejected; a candidate cannot read another candidate's attempt; an Evaluator gets no PII; RBAC denials.

## 14. Goals / non-goals / anti-goals

**Goals (v1):** everything above. Specifically: import candidates and questions, OTP login with static-OTP fallback, timed descriptive exam with paste blocked and logged, robust autosave, server-enforced auto-submit, manual marking, shortlist/reject, XLSX export, admin-entered SMS/email credentials.

**Non-goals (later):** MCQ/coding/auto-marking, IP geolocation lookups via an external service, continuous location tracking during the exam, full-screen enforcement, webcam proctoring, analytics charts, interview scheduling, examiner-to-role assignment, permission editor, BullMQ bulk imports. (Deployment is covered separately in `deployment.md`.)

**Anti-goals (failure even if it "works"):**
- A candidate loses typed text or minutes because of the platform.
- A candidate sees another role's questions, another candidate's data, or any evaluator guidance or marks.
- The static `123456` OTP quietly works in a real exam.
- The project depends on anything inside the CRM repo.

## 15. Decided by the user

- Descriptive-only answers (1,000–1,500 words); manual marking after the exam.
- Paste must not be possible into the answer box.
- Questions are uploaded from the admin dashboard per role.
- SMS and email sending built in the same manner as the CRM, with credentials entered by the admin.
- Static OTP `123456` (SMS and email) until real credentials are entered.
- Candidate data shape as in §6.1.
- UI references and Arihant theme taken from the CRM.
- Standalone project, to be moved out of this repo later.
- Capture the candidate's location at login.
- Follow the CRM's coding practices and keep the security checks (§13).

## 16. Builder's calls (user can override)

- v1 scope cut in §13; Super Admin + Evaluator roles; all role questions in fixed order; free navigation; soft word limit; 60 min default; candidates never see marks.
- Role chosen per upload file, plus optional `job_role` column.
- `ALLOW_STATIC_OTP` safety flag.
- Bulk-insert heuristic thresholds (200 chars / 2 s).
- One attempt per candidate; Super Admin-only reset.
- Ports 4100/5174, DB `exam_db`.
- Blind marking for Evaluators; Super Admin sees everything (§8).
- Question lock after first start, with an audited Super Admin unlock (§5).
- System-wide static-OTP rule plus CLI break-glass (§7.2).
- Location required to Start (not to log in), with Super Admin exemption (the alert-and-re-ask behaviour is the user's); flag thresholds 50 km / 100 m / 3 per IP (§7.2a).
- Typed-vs-grown paste detection with configurable thresholds (§7.4).

## 17. Left to the builder

Folder/module structure inside each app, exact component breakdown, API route naming, test approach, autosave timing constants, exact XLSX parsing library (e.g. `exceljs`).
