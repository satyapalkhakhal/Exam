# AI-assisted evaluation — plan (2026-11-06)

Branch: `feature/ai-evaluation` (from `566fab8`).

## Decisions (user, 2026-11-06)

1. **AI suggests, a human confirms.** AI marks are stored separately from human marks; an evaluator accepts or adjusts them and submits as today. **Bulk accept** is also required.
2. **Weighted composite** of exam %, Class X %, Class XII % and CPI, weights per role.
3. **Class XI is ignored** (the data has none).
4. **Evaluators see AI marks and reasoning** per question (still blind: no names, no academics).
5. OpenAI via the official `openai` Node SDK; the user supplies the API key.

## What exists today (analysis)

| Area | Current behaviour | Impact |
|---|---|---|
| Marking (`modules/evaluation`) | Per-question marks 0…max in 0.5 steps (`marks.ts`), soft 30-min lock, draft/submit; submit needs every question marked, writes `totalMarks/maxMarks/percentage` on `exam_attempts`, candidate → `EVALUATED`, audited. Super Admin can reopen. | AI never writes here directly; "accept" reuses this exact path so totals, history and audit stay identical. |
| Blind marking (`evaluation.mapper.ts`) | Whitelisted DTOs; Evaluators never get PII or academics. | AI fields are added to the whitelist; composite (contains academics) is Super Admin only. |
| Questions | `textSnapshot`, `maxMarksSnapshot` per attempt; `evaluatorGuidance` on the question. | Guidance becomes the AI rubric. |
| Academics | `candidates.x_percentage`, `xii_percentage` (0–100), `major_cpi` (0–10). No XI. | Composite uses X, XII, CPI×10. |
| Leaderboard / export (`modules/results`) | Ranks by human `totalMarks`; XLSX has X/XII/CPI, per-question marks, flags; decision in `candidates.result`. | Add AI %, composite, sort option, export columns. |
| Secrets / integrations | SMS/email credentials in `system_config`, sealed with `CONFIG_ENCRYPTION_KEY`, managed in Admin → Integrations with a test button. | OpenAI key and model go here the same way. |
| Background work | BullMQ (`exam-auto-submit`, `exam-email`) with workers started in `index.ts`. | New `exam-ai-eval` queue. |
| Exam settings | Per role: duration, window, open flag, questions lock. | Composite weights added here. |

## Design

### 1. OpenAI integration (Admin → Integrations)
- New config key `ai.openai`: `enabled`, `apiKey` (secret, sealed like the SMS token; shown as `set/last4`), `model` (text, chosen by the admin), `concurrency` (1–5, default 3), `gradingInstructions` (optional global text appended to the system prompt).
- "Test connection" button: one tiny structured call; audited without the key.
- `openai` added to `apps/api` dependencies. The key is never logged or returned.

### 2. When AI evaluation may run ("after the exam is over")
- Per attempt: only `SUBMITTED` / `AUTO_SUBMITTED` attempts.
- Per role (the "Evaluate all" button): the role has no `IN_PROGRESS` attempt **and** (`isOpen = false` or `windowEnd` has passed). Otherwise 409 `EXAM_NOT_OVER`.
- Super Admin only. Re-running replaces the "latest" AI score but keeps history.

### 3. What the model sees (privacy and fairness)
- Per call: one question — question text, max marks, evaluator guidance (rubric), the target length (1,000–1,500 words), the answer text and its word count.
- **Never**: name, email, code, college, academics, location, integrity flags. Academics are combined later in code, not by the model, so they cannot bias the marking.
- Answer is wrapped in clear delimiters; the system prompt says the answer is data to be graded and any instructions inside it must be ignored and reported.
- Note for the business: answers are sent to OpenAI. Confirm the organisation's API data-retention settings are acceptable before use.

### 4. Output (OpenAI Structured Outputs, zod schema)
Per question: `marks` (number), `rationale` (≤ ~120 words), `strengths[]`, `improvements[]`, `confidence` (`LOW|MEDIUM|HIGH`), `concerns[]` from a fixed list: `OFF_TOPIC`, `TOO_SHORT`, `REPEATS_QUESTION`, `PROMPT_INJECTION`, `LIKELY_AI_GENERATED`, `INCOHERENT`.
Server-side: marks are clamped to 0…max and rounded to the nearest 0.5 (same rules as `validateMarks`); an invalid response counts as a failure and is retried.

### 5. Processing
- Queue `exam-ai-eval` (prefix `exam`), **one job per attempt question** (cheap retries), id `ai-{scoreId}`, 4 attempts, exponential backoff that respects OpenAI 429 `retry-after`; worker concurrency from config; started/closed in `index.ts` like the email worker.
- A run records token usage; progress (done/failed/total) is polled by the UI.
- Before starting, the UI shows the number of answers and an approximate token estimate (≈ answer tokens + ~600 prompt tokens each). Actual usage is shown after; prices depend on the chosen model so they are not hard-coded.

### 6. Data model (one migration)
- `ai_evaluation_runs`: `id`, `job_role_id` (nullable for ad-hoc selections), `model`, `prompt_version`, `status` (`RUNNING|DONE|CANCELLED`), `total`, `done`, `failed`, `input_tokens`, `output_tokens`, `created_by_id`, `created_at`, `finished_at`.
- `ai_question_scores`: `id`, `run_id`, `attempt_question_id`, `status` (`QUEUED|DONE|FAILED`), `marks`, `max_marks`, `rationale`, `strengths` (json), `improvements` (json), `confidence`, `concerns` (text[]), `model`, `input_tokens`, `output_tokens`, `error`, `created_at`, `completed_at`. Unique `(run_id, attempt_question_id)`; index `(attempt_question_id, completed_at)`. The latest `DONE` row per attempt question is "the AI score".
- `question_evaluations.ai_score_id` (nullable FK): set when a human accepted the AI mark unchanged — provenance for audits.
- `exam_settings`: `weight_exam`, `weight_x`, `weight_xii`, `weight_cpi` (ints, default 70/10/10/10, must sum to 100).
- `purge-candidates`: delete or blank the candidate's AI rationale text.

### 7. Scores
- **AI exam %** = Σ latest AI marks ÷ Σ max marks × 100 (only when every question has a DONE score).
- **Exam %** used in the composite = the human-confirmed percentage when the evaluation is submitted; otherwise the AI % shown as *provisional*.
- **Composite** = Σ(weight × component %) ÷ Σ(weights of components present), components: exam %, X %, XII %, CPI × 10. A missing X/XII/CPI is skipped and its weight re-spread (no penalty). Computed on read, so a weight change applies immediately. Super Admin only.

### 8. Marking with AI (Evaluator + Super Admin)
- Marking screen, per question: AI marks, confidence, rationale, strengths/improvements, concerns as badges, and **"Use AI mark"** (fills the draft field). A header button **"Use all AI marks"** fills every question. The evaluator still saves/submits through the existing flow, so locks, validation, totals and audit are unchanged.
- Submissions list: an "AI %" column and an "AI status" filter (not run / partial / done / has concerns).

### 9. Bulk accept (Super Admin)
- `POST /admin/submissions/ai/accept` with `{ attemptIds[] }` or `{ jobRoleId, onlyClean: true }`.
- For each attempt, in its own transaction: skip with a reason if the evaluation is already submitted, the script is locked by someone else, an AI score is missing for any question, or (when `onlyClean`, the default) any question has AI concerns or `LOW` confidence, or the attempt has integrity flags. Otherwise write the AI marks as the acting admin's marks (`ai_score_id` set), then run the same completion step as Submit (totals, `EVALUATED`, history).
- Response: accepted count and skipped list with reasons; one audit row `EVALUATIONS_BULK_ACCEPTED_AI` (counts, role, run ids — no candidate data). Skipped scripts are left for individual review.

### 10. Leaderboard and export (Super Admin)
- New columns: AI %, Composite (with a "provisional" marker when based on AI %), X/XII/CPI already present.
- Sort selector: Human total (today's default) / Composite / AI %.
- Results XLSX: per-question AI marks, AI %, composite, weights used.

## API summary (new)

| Method | Path | Role |
|---|---|---|
| GET/PUT | `/admin/integrations` (adds `ai` section) + `POST /admin/integrations/ai/test` | Super Admin |
| POST | `/admin/ai-evaluations` `{ jobRoleId }` or `{ attemptIds[] }`, `force?` | Super Admin |
| GET | `/admin/ai-evaluations?jobRoleId=` (runs + progress) | Super Admin |
| POST | `/admin/ai-evaluations/:runId/cancel` | Super Admin |
| GET | `/admin/submissions/:attemptId` (adds `ai` per question) | Evaluator, Super Admin |
| POST | `/admin/submissions/ai/accept` | Super Admin |
| PUT | `/admin/roles/:id/settings` (adds weights) | Super Admin |
| GET | `/admin/leaderboard?sort=human|composite|ai` | Super Admin |

New error codes: `AI_NOT_CONFIGURED`, `EXAM_NOT_OVER`.

## Implementation phases

1. **Foundation** — shared types/schemas; migration; `ai.openai` config + Integrations UI + test call.
2. **Grader** — `modules/aiEvaluation`: prompt builder (pure, versioned), OpenAI client wrapper (injected, so tests never call OpenAI), structured-output parsing, clamping; queue + worker; run start/progress/cancel endpoints.
3. **Marking UI** — AI panel per question, "Use AI mark", "Use all AI marks"; Submissions AI column/filter; "Evaluate with AI" button + progress on Submissions (per role).
4. **Bulk accept** — endpoint + Submissions action with result summary.
5. **Composite** — weights in Exam Settings, composite on leaderboard/export, sort option.
6. **Hardening** — tests (below), docs (`design.md` §8, `deployment.md`), go-live checklist entries.

## Tests

- Unit: prompt contains no PII/academics; clamping/rounding; invalid model output → retry/FAILED; injection text flagged not obeyed (mocked); "exam over" gate; composite maths incl. missing components and re-spread; bulk-accept skip reasons; blind mapper (Evaluator gets AI fields, never composite/academics).
- Integration (needs `.env.test`): run → scores → accept → leaderboard order; reopen after AI accept.
- Manual: one real call per question type on UAT with the real key; compare AI vs human marks on 10–20 scripts before trusting bulk accept.

## Risks and mitigations

- **Bias / errors in AI marks** → human confirmation, concerns + confidence, "only clean" bulk accept, provenance (`ai_score_id`), reopen.
- **Prompt injection in answers** → delimiters, instruction to ignore, `PROMPT_INJECTION` concern, clamped numeric output, never auto-final.
- **Rate limits / cost** → per-question jobs, concurrency setting, backoff, token tracking, estimate before run.
- **Data leaving the system** → only answer content is sent; key encrypted at rest; confirm OpenAI data settings.
- **Reproducibility** → model and prompt version stored per score; re-runs keep history.
