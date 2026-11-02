# Candidate email templates (2026-11-03)

Decided by the user: two templates, **Submission received** and **Shortlisted for next round**, are **editable and sent manually from the admin panel** (Super Admin only). Nothing is sent automatically.

Contract types: `packages/shared/src/schemas/emails.ts`. Existing builders: `apps/api/src/modules/messaging/candidateEmails.ts`.

## Templates

- Stored in `system_config` under `email_template.SUBMISSION_RECEIVED` and `email_template.SHORTLISTED` as `{ subject, body }` (not secret). No row = the built-in default, which is today's wording from `candidateEmails.ts` rewritten as subject/body text with placeholders.
- Admins edit only the **subject** and the **body** (plain text; a blank line = new paragraph; `{placeholder}` tokens). The API keeps adding the branded layout, the details table (role, code, times, counts / next-round fields), the link button, the "Before the round" list and the footer. Substituted values are HTML-escaped; the template text itself is escaped too (admins cannot inject HTML).
- Placeholders (`EMAIL_TEMPLATE_PLACEHOLDERS`): all templates `{firstName} {fullName} {role} {candidateCode} {contactEmail}`; Submission `{submittedAt} {answeredCount} {questionCount}`; Shortlisted `{roundName} {scheduledAt} {confirmBy}`. An unknown token on save → 400 `VALIDATION_ERROR` naming it. A placeholder whose value is missing renders as empty (e.g. no `scheduledAt`) — the default shortlist body must read well without the optional next-round fields.
- `contactEmail` = the email integration's reply-to if set, else `hrd@arihantcapital.com`.
- Save and reset are audit-logged (`EMAIL_TEMPLATE_UPDATED` / `EMAIL_TEMPLATE_RESET`, metadata: key only).

## Sending

- `email_dispatches` (new table): `id`, `batch_id`, `template`, `candidate_id` (FK), `to_email`, `subject`, `html`, `text`, `status` (QUEUED/SENT/FAILED), `error`, `attempts`, `sent_by_id` (admin FK), `created_at`, `sent_at`. Index `(candidate_id, template)`, `(batch_id)`, `(status)`. The rendered content is stored so the record shows exactly what was sent.
- `POST /admin/emails/send`: requires the email channel to be ready (`isChannelReady(getEmailConfig())`), else 409 `EMAIL_NOT_CONFIGURED`. Per candidate, skip with a reason: `NOT_FOUND`; `INELIGIBLE` (eligible=false); `NOT_SUBMITTED` (Submission template and no SUBMITTED/AUTO_SUBMITTED attempt); `NOT_SHORTLISTED` (Shortlisted template and status ≠ SHORTLISTED); `ALREADY_SENT` (a QUEUED or SENT dispatch of this template exists and `resend` is not true). The rest are rendered with the current template, inserted as QUEUED in one transaction, and one BullMQ job per dispatch is added to queue `exam-email` (prefix `exam`, job id `email-{dispatchId}`, 3 attempts, exponential backoff). Audit: `EMAILS_QUEUED` with template, count, batchId (no emails/names).
- Worker (started in `index.ts` next to the auto-submit worker, concurrency 3, closed on shutdown): loads the dispatch, skips unless QUEUED, sends via `sendEmail`, marks SENT + `sent_at`, or on the final failed attempt FAILED + error message (never the email body). Logs mask the address.
- Submission data comes from the application's current non-RESET attempt (`submittedAt`, `submitType`, answered/question counts). Next-round data comes from the request.

## Admin HTTP API (all Super Admin, mounted with the `superAdminOnly` guard)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/admin/email-templates` | | `{ templates: EmailTemplateDto[] }` |
| PUT | `/admin/email-templates/:key` | `EmailTemplateUpdateSchema` | `EmailTemplateDto` |
| POST | `/admin/email-templates/:key/reset` | | `EmailTemplateDto` |
| POST | `/admin/email-templates/:key/preview` | `EmailPreviewSchema` | `EmailRenderedDto` (sample candidate "Ajith K K", ARC-0042, the first active role's name or "Backend Engineer") |
| POST | `/admin/email-templates/:key/test` | `EmailPreviewSchema` | `{ sentTo }` — sends the preview to the signed-in admin's own email (409 `EMAIL_NOT_CONFIGURED` if not ready) |
| POST | `/admin/emails/send` | `EmailSendSchema` | `EmailSendResultDto` |
| GET | `/admin/emails` | `EmailDispatchListQuerySchema` | `Paginated<EmailDispatchDto>` (newest first) |

## Admin web

- Nav item **Email templates** (Super Admin) → `/admin/email-templates`: one tab per template with subject input, body textarea, placeholder chips that insert at the cursor, Save, Reset to default (confirm), Send test to me, and a live preview (debounced call to `/preview`) rendered in a sandboxed `<iframe srcdoc sandbox="">`. The Shortlisted tab has sample next-round fields that feed the preview only. A second section/tab **Sent emails** lists dispatches (filters: template, status) with status badges and the error on FAILED.
- **Send email** dialog (shared component): template select, the next-round form for Shortlisted (name, mode, date+time and confirm-by entered in IST, venue, https link + label, instructions), a "send again to candidates who already received it" checkbox, a preview of the email for the first selected candidate's template (sample data is fine), recipient count, Send → summary of queued and skipped (with reasons in plain words).
  - Candidates page: bulk action "Send email" for the selection.
  - Leaderboard: "Email" action per row (opens the dialog with Shortlisted preselected for SHORTLISTED rows).
  - Candidate detail: an "Emails" card listing that candidate's dispatches, and a "Send email" button.
- If the API answers `EMAIL_NOT_CONFIGURED`, show "Email is not set up. Configure it in Integrations." with a link.

## Data protection

- `purge-candidates` anonymises the candidate's dispatches too (`to_email`, `subject`, `html`, `text`).
- Evaluators never see any of this.
