# Multiple exams per candidate (2026-11-03)

> **Amended 2026-11-10 (colleges, placement/internship and campus drives):** an application
> is now **account × drive**, not account × job role. A drive is one round of a job profile
> at one college in one batch; job profiles have rounds (question bank, duration, weights,
> question lock) and each round has one drive per college + batch (window, open switch,
> instructions). Imports, "Move to drive", leaderboards, exports and AI runs work per drive;
> a person can't be in two colleges' drives of the same round and batch. Where this page
> says "role" for an application, read "drive". Full design:
> `docs/superpowers/specs/2026-11-10-colleges-drives-rounds-design.md`.

Decided by the user: **one exam per job role, a person may hold several roles; HR/Super Admin enrols them** (import or the candidate page). Candidates never pick exams themselves. This amends design.md §3, §4 ("every candidate belongs to exactly one role") and §6.

## Model

- **`candidate_accounts`** (new) — the person who signs in: `id`, `email` (unique), `mobile` (unique, nullable), timestamps.
- **`candidates`** keeps its meaning for everything admin-side but is now **one application** = (account × job role): candidate code, role, status, eligible, location exempt, roll number/academics, attempts, marks, flags, history. New `account_id` FK (not null). `email`/`mobile` stay on the row as copies of the account's (search, exports and blind-marking code paths are unchanged); every write that sets them goes through the account so they never drift. Unique `(account_id, job_role_id)`; `email` and `mobile` are no longer unique on `candidates` (plain indexes).
- Migration: create one account per existing candidate (email is unique today, so 1:1), backfill `account_id`, set NOT NULL, swap the unique constraints. Relaxes two unique constraints; adds everything else.

## Auth

- Candidate tokens, refresh tokens, OTP subjects, session-valid-after and the exam family binding are keyed by **account id**. Revoking a candidate (deactivation, reset, etc.) revokes its account's sessions.
- `isActive(accountId)` = the account has at least one eligible application.
- Sign-in by email → account by email; by mobile → account by mobile. Unknown / no eligible application → same silent `{sent:true}` / `OTP_INVALID` as today.
- Mobile self-registration: account by email, with an eligible application whose roll number matches, and account mobile empty → link on the account and all its rows in one transaction. OTP subject `${accountId}:${mobile}`.
- LOGIN-stage location is recorded once per eligible application of the account (so per-application review flags work unchanged). `locationCaptured` = a GRANTED LOGIN row for any of the account's applications with this login family. EXAM_START is recorded on the application being started.
- **One exam at a time**: starting application B while another application of the same account has an unexpired IN_PROGRESS attempt → `409 ANOTHER_EXAM_IN_PROGRESS` (checked under a `candidate_accounts` row lock in the start transaction).

## Candidate HTTP API (`/api/candidate`)

Unchanged: `auth/*`, `POST /location`. `/me`, verify-otp, refresh, register-mobile/verify return `{ candidate: CandidateSelf }` with the new account-level shape (`packages/shared/src/schemas/auth.ts`).

New (types in `packages/shared/src/schemas/candidateExams.ts`):

| Method | Path | Returns |
|---|---|---|
| GET | `/exams` | `CandidateExamListDto` (eligible applications, ordered by role name) |
| GET | `/exams/:applicationId` | `CandidateExamDetailDto` |
| POST | `/exams/:applicationId/start` | `ExamState` (body `ExamStartSchema`) |
| GET | `/exams/:applicationId/state` | `ExamState` |
| GET | `/exams/:applicationId/summary` | `ExamSummaryDto` |
| POST | `/exams/:applicationId/resume` | `ExamState` |
| PUT | `/exams/:applicationId/answers/:attemptQuestionId` | `SaveAnswerResult` |
| POST | `/exams/:applicationId/answers/:attemptQuestionId/beacon` | (text/plain beacon, as before) |
| POST | `/exams/:applicationId/events` | `{ recorded }` |
| POST | `/exams/:applicationId/submit` | `{ status, submittedAt }` |

Removed: `GET /exam/info` and everything under `/candidate/exam/*`. An application that is not the caller's or not eligible is a 404. Middleware order, rate limits, the beacon's refresh-cookie fallback and `sameOriginOnly` are as before.

## Candidate web

- `/dashboard` — **My exams**: header (name, email, sign out), the location banner when `!locationCaptured && !locationExempt`, then sections: *In progress* (Resume), *Available now* (Open), *Upcoming* (opens at…), *Closed / not open*, *Completed* (submitted at…, View receipt). Empty state when there are no exams.
- `/exams/:applicationId` — the former dashboard for one exam: code, role, duration, window, instructions, rules, "I have read" checkbox, Start / Resume; back to My exams.
- `/exams/:applicationId/take` — the exam screen. `/exams/:applicationId/submitted` — the receipt, with "Back to my exams".
- Old `/exam` and `/submitted` redirect to `/dashboard`.

## Admin side

- Import: a duplicate is now the same email **in the same role**. The same email under another role creates a new application on the existing account (the preview says "linked to existing candidate"). A mobile that belongs to a different account is still an error.
- Add candidate / edit: an email that already has an account attaches to it; (account, role) already present → conflict. Changing an application's mobile changes the account's mobile (all its applications).
- Bulk role change: refuse a row whose account already holds the target role (`SAME_PERSON_HAS_ROLE`).
- Candidate detail shows the person's other applications (code, role, status) with links.
- `purge-candidates` anonymises accounts too.
