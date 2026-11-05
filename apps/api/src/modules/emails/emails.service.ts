// modules/emails/emails.service.ts
// Editable candidate email templates and manual, queued sending
// (docs/email-templates.md). Templates are { subject, body } rows in
// system_config; no row (or a reset one) means the built-in default. Sending
// renders each email with the current template, stores it as a QUEUED
// dispatch in one transaction and hands one job per dispatch to the queue; the
// worker (createDispatchProcessor) delivers it. Everything is injected so the
// rules are testable without Postgres, Redis or a mail provider.

import type {
  EmailDispatchDto,
  EmailDispatchListQuery,
  EmailDispatchStatus,
  EmailPreviewInput,
  EmailRenderedDto,
  EmailSendInput,
  EmailSendResultDto,
  EmailSkipReason,
  EmailTemplateDto,
  EmailTemplateKey,
  EmailTemplateUpdateInput,
  NextRoundInput,
  Paginated,
} from '@exam/shared';
import { EMAIL_TEMPLATE_KEYS, EMAIL_TEMPLATE_PLACEHOLDERS } from '@exam/shared';
import { AppError, badRequest, conflict, unauthorized } from '../../shared/errors.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { maskEmail } from '../../shared/utils/piiMask.js';
import {
  DEFAULT_EMAIL_TEMPLATES,
  DEFAULT_HR_CONTACT,
  buildRejectionEmail,
  buildShortlistEmail,
  buildSubmissionEmail,
  unknownPlaceholders,
  type AssessmentSummary,
  type EmailContent,
  type EmailTemplate,
  type NextRoundDetails,
} from '../messaging/candidateEmails.js';
import { MessagingError } from '../messaging/messaging.errors.js';
import type { EmailConfig } from '../messaging/messaging.config.js';
import type { SendEmailParams } from '../messaging/email.client.js';
import type { SystemConfigService } from '../systemConfig/index.js';
import { EMAIL_TEMPLATE_META, placeholderDocs } from './emails.templates.js';

export const TEMPLATE_CONFIG_KEY = (key: EmailTemplateKey): string => `email_template.${key}`;
const NOT_CONFIGURED = 'Email is not set up. Configure it in Integrations.';
const SAMPLE = { fullName: 'Ajith K K', candidateCode: 'ARC-0042', fallbackRole: 'Backend Engineer' } as const;
const MAX_ERROR_LENGTH = 500;

export interface AuditEntry {
  adminId: string;
  action: string;
  entity: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export interface EmailCandidate {
  id: string;
  candidateCode: string;
  fullName: string;
  email: string;
  eligible: boolean;
  status: string;
  /** HR's outcome, kept apart from the exam status. */
  result: 'SHORTLISTED' | 'REJECTED' | null;
  jobRoleName: string;
  /** The current (non-RESET) attempt, if any. */
  attempt: {
    status: string;
    startedAt: Date | null;
    submittedAt: Date | null;
    submitType: 'MANUAL' | 'AUTO' | null;
    answeredCount: number;
    questionCount: number;
    /** Set only once marking is complete (the attempt's stored totals). */
    score: { total: number; max: number; percentage: number } | null;
  } | null;
}

export interface NewDispatch {
  template: EmailTemplateKey;
  candidateId: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
}

export interface DispatchRow {
  id: string;
  batchId: string;
  template: EmailTemplateKey;
  candidateId: string;
  candidateCode: string;
  fullName: string;
  toEmail: string;
  subject: string;
  status: EmailDispatchStatus;
  error: string | null;
  sentByName: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

export interface EmailsRepository {
  templateMeta(keys: string[]): Promise<Map<string, { updatedAt: Date; updatedByName: string | null }>>;
  firstActiveRoleName(): Promise<string | null>;
  adminEmail(adminId: string): Promise<string | null>;
  findCandidates(ids: string[]): Promise<EmailCandidate[]>;
  /** Candidates with a QUEUED or SENT dispatch of this template. */
  candidateIdsWithActiveDispatch(ids: string[], template: EmailTemplateKey): Promise<Set<string>>;
  /** Inserts the QUEUED rows and the audit row in one transaction; returns the new ids. */
  createDispatches(batchId: string, sentById: string, rows: NewDispatch[], audit: AuditEntry): Promise<string[]>;
  failDispatches(ids: string[], error: string): Promise<void>;
  listDispatches(q: EmailDispatchListQuery): Promise<{ items: DispatchRow[]; total: number }>;
}

export interface EmailsDeps {
  repo: EmailsRepository;
  config: Pick<SystemConfigService, 'getConfig' | 'setConfig'>;
  audit: (entry: AuditEntry) => Promise<void>;
  getEmailConfig: () => Promise<EmailConfig>;
  isChannelReady: (cfg: EmailConfig) => boolean;
  sendEmail: (p: SendEmailParams) => Promise<void>;
  /** Adds one queue job per dispatch id. */
  enqueue: (dispatchIds: string[]) => Promise<void>;
  newBatchId: () => string;
  /** Exam site's public URL; the emails load their logo and app icon from it. */
  assetBaseUrl?: string;
}

const isCustom = (v: Partial<EmailTemplate>): v is EmailTemplate =>
  typeof v.subject === 'string' && v.subject !== '' && typeof v.body === 'string' && v.body !== '';

function toNextRound(input: NextRoundInput | undefined): NextRoundDetails | undefined {
  if (!input) return undefined;
  return {
    name: input.name,
    mode: input.mode,
    venue: input.venue,
    link: input.link,
    linkLabel: input.linkLabel,
    instructions: input.instructions,
    scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
    confirmBy: input.confirmBy ? new Date(input.confirmBy) : undefined,
  };
}

function assertKnownPlaceholders(key: EmailTemplateKey, t: Partial<EmailTemplate>): void {
  const allowed = EMAIL_TEMPLATE_PLACEHOLDERS[key];
  const unknown = [...new Set([...unknownPlaceholders(t.subject ?? '', allowed), ...unknownPlaceholders(t.body ?? '', allowed)])];
  if (unknown.length > 0) {
    throw badRequest(`Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{${u}}`).join(', ')}`);
  }
}

export function createEmailsService(deps: EmailsDeps) {
  const { repo } = deps;

  async function loadTemplate(key: EmailTemplateKey): Promise<{ template: EmailTemplate; isDefault: boolean }> {
    const stored = await deps.config.getConfig<Partial<EmailTemplate>>(TEMPLATE_CONFIG_KEY(key));
    return isCustom(stored) ? { template: { subject: stored.subject, body: stored.body }, isDefault: false } : { template: DEFAULT_EMAIL_TEMPLATES[key], isDefault: true };
  }

  async function toDto(key: EmailTemplateKey, meta?: Map<string, { updatedAt: Date; updatedByName: string | null }>): Promise<EmailTemplateDto> {
    const { template, isDefault } = await loadTemplate(key);
    const m = isDefault ? undefined : (meta ?? (await repo.templateMeta([TEMPLATE_CONFIG_KEY(key)]))).get(TEMPLATE_CONFIG_KEY(key));
    return {
      key,
      ...EMAIL_TEMPLATE_META[key],
      subject: template.subject,
      body: template.body,
      placeholders: placeholderDocs(key),
      isDefault,
      updatedAt: m ? m.updatedAt.toISOString() : null,
      updatedByName: m?.updatedByName ?? null,
    };
  }

  async function listTemplates(): Promise<{ templates: EmailTemplateDto[] }> {
    const meta = await repo.templateMeta(EMAIL_TEMPLATE_KEYS.map(TEMPLATE_CONFIG_KEY));
    return { templates: await Promise.all(EMAIL_TEMPLATE_KEYS.map((k) => toDto(k, meta))) };
  }

  async function saveTemplate(key: EmailTemplateKey, input: EmailTemplateUpdateInput, adminId: string): Promise<EmailTemplateDto> {
    assertKnownPlaceholders(key, input);
    await deps.config.setConfig(TEMPLATE_CONFIG_KEY(key), { subject: input.subject, body: input.body }, adminId);
    await deps.audit({ adminId, action: 'EMAIL_TEMPLATE_UPDATED', entity: 'email_template', entityId: key, metadata: { key } });
    return toDto(key);
  }

  async function resetTemplate(key: EmailTemplateKey, adminId: string): Promise<EmailTemplateDto> {
    await deps.config.setConfig(TEMPLATE_CONFIG_KEY(key), {}, adminId);
    await deps.audit({ adminId, action: 'EMAIL_TEMPLATE_RESET', entity: 'email_template', entityId: key, metadata: { key } });
    return toDto(key);
  }

  const contactOf = (cfg: EmailConfig): string => cfg.replyTo.trim() || DEFAULT_HR_CONTACT;

  async function renderPreview(key: EmailTemplateKey, input: EmailPreviewInput): Promise<EmailRenderedDto> {
    const saved = (await loadTemplate(key)).template;
    const template: EmailTemplate = { subject: input.subject ?? saved.subject, body: input.body ?? saved.body };
    assertKnownPlaceholders(key, template);
    const [cfg, role] = await Promise.all([deps.getEmailConfig(), repo.firstActiveRoleName()]);
    const base = {
      fullName: SAMPLE.fullName,
      candidateCode: SAMPLE.candidateCode,
      jobRoleName: role ?? SAMPLE.fallbackRole,
      contactEmail: contactOf(cfg),
      assetBaseUrl: deps.assetBaseUrl,
    };
    if (key === 'SUBMISSION_RECEIVED') return buildSubmissionEmail({ ...base, submittedAt: new Date(), submitType: 'MANUAL', answeredCount: 2, questionCount: 3 }, template);
    if (key === 'REJECTED') return buildRejectionEmail(base, template);
    const now = Date.now();
    const sample: AssessmentSummary = {
      startedAt: new Date(now - 52.5 * 60_000),
      submittedAt: new Date(now),
      submitType: 'MANUAL',
      answeredCount: 8,
      questionCount: 10,
      score: { total: 34.5, max: 50, percentage: 69 },
    };
    return buildShortlistEmail({ ...base, nextRound: toNextRound(input.nextRound), assessment: sample }, template);
  }

  async function sendTest(key: EmailTemplateKey, input: EmailPreviewInput, adminId: string): Promise<{ sentTo: string }> {
    if (!deps.isChannelReady(await deps.getEmailConfig())) throw conflict(NOT_CONFIGURED, 'EMAIL_NOT_CONFIGURED');
    const to = await repo.adminEmail(adminId);
    if (!to) throw unauthorized();
    const rendered = await renderPreview(key, input);
    try {
      await deps.sendEmail({ to, ...rendered });
    } catch (err) {
      if (err instanceof MessagingError) throw new AppError(502, 'BAD_GATEWAY', err.message);
      throw err;
    }
    return { sentTo: to };
  }

  function render(key: EmailTemplateKey, c: EmailCandidate, template: EmailTemplate, contactEmail: string, nextRound: NextRoundDetails | undefined): EmailContent {
    const base = { fullName: c.fullName, candidateCode: c.candidateCode, jobRoleName: c.jobRoleName, contactEmail, assetBaseUrl: deps.assetBaseUrl };
    if (key === 'SHORTLISTED') {
      const a = c.attempt;
      const assessment: AssessmentSummary | undefined = a
        ? { startedAt: a.startedAt, submittedAt: a.submittedAt, submitType: a.submitType, answeredCount: a.answeredCount, questionCount: a.questionCount, score: a.score }
        : undefined;
      return buildShortlistEmail({ ...base, nextRound, assessment }, template);
    }
    if (key === 'REJECTED') return buildRejectionEmail(base, template);
    const a = c.attempt;
    return buildSubmissionEmail(
      {
        ...base,
        submittedAt: a?.submittedAt ?? new Date(),
        submitType: a?.submitType ?? 'MANUAL',
        answeredCount: a?.answeredCount ?? 0,
        questionCount: a?.questionCount ?? 0,
      },
      template,
    );
  }

  function skipReason(key: EmailTemplateKey, c: EmailCandidate | undefined, alreadySent: boolean): EmailSkipReason | null {
    if (!c) return 'NOT_FOUND';
    // An anonymised candidate (purge-candidates) has no real address left.
    if (!c.eligible || c.email.toLowerCase().endsWith('@invalid')) return 'INELIGIBLE';
    if (key === 'SUBMISSION_RECEIVED' && !(c.attempt && (c.attempt.status === 'SUBMITTED' || c.attempt.status === 'AUTO_SUBMITTED'))) return 'NOT_SUBMITTED';
    if (key === 'SHORTLISTED' && c.result !== 'SHORTLISTED') return 'NOT_SHORTLISTED';
    if (key === 'REJECTED' && c.result !== 'REJECTED') return 'NOT_REJECTED';
    return alreadySent ? 'ALREADY_SENT' : null;
  }

  async function send(input: EmailSendInput, adminId: string): Promise<EmailSendResultDto> {
    const cfg = await deps.getEmailConfig();
    if (!deps.isChannelReady(cfg)) throw conflict(NOT_CONFIGURED, 'EMAIL_NOT_CONFIGURED');

    const ids = [...new Set(input.candidateIds)];
    const [found, active, { template }] = await Promise.all([
      repo.findCandidates(ids),
      input.resend ? Promise.resolve(new Set<string>()) : repo.candidateIdsWithActiveDispatch(ids, input.template),
      loadTemplate(input.template),
    ]);
    const byId = new Map(found.map((c) => [c.id, c]));
    const nextRound = input.template === 'SHORTLISTED' ? toNextRound(input.nextRound) : undefined;
    const contact = contactOf(cfg);

    const batchId = deps.newBatchId();
    const skipped: EmailSendResultDto['skipped'] = [];
    const rows: NewDispatch[] = [];
    for (const id of ids) {
      const c = byId.get(id);
      const reason = skipReason(input.template, c, active.has(id));
      if (reason || !c) {
        skipped.push({ candidateId: id, candidateCode: c?.candidateCode ?? null, fullName: c?.fullName ?? null, reason: reason ?? 'NOT_FOUND' });
        continue;
      }
      rows.push({ template: input.template, candidateId: id, toEmail: c.email, ...render(input.template, c, template, contact, nextRound) });
    }
    if (rows.length === 0) return { batchId, queued: 0, skipped };

    const dispatchIds = await repo.createDispatches(batchId, adminId, rows, {
      adminId,
      action: 'EMAILS_QUEUED',
      entity: 'email_dispatch',
      entityId: batchId,
      metadata: { template: input.template, count: rows.length, batchId },
    });
    try {
      await deps.enqueue(dispatchIds);
    } catch (err) {
      await repo.failDispatches(dispatchIds, 'Could not be queued for sending');
      throw err;
    }
    return { batchId, queued: rows.length, skipped };
  }

  async function listDispatches(q: EmailDispatchListQuery): Promise<Paginated<EmailDispatchDto>> {
    const { items, total } = await repo.listDispatches(q);
    return {
      items: items.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), sentAt: r.sentAt ? r.sentAt.toISOString() : null })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  return { listTemplates, saveTemplate, resetTemplate, renderPreview, sendTest, send, listDispatches };
}

export type EmailsService = ReturnType<typeof createEmailsService>;

// ---- worker side ---------------------------------------------------------------

export interface QueuedDispatch {
  id: string;
  status: EmailDispatchStatus;
  template: EmailTemplateKey;
  /** The candidate's result now, so an outcome email that no longer matches is not sent. */
  candidateResult: 'SHORTLISTED' | 'REJECTED' | null;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
}

export interface DispatchRepository {
  findForSend(id: string): Promise<QueuedDispatch | null>;
  /** Only a QUEUED row changes; returns false when it was not QUEUED. */
  markSent(id: string): Promise<boolean>;
  /** Counts the attempt; also sets FAILED + error when `final`. Only a QUEUED row changes. */
  recordFailure(id: string, error: string, final: boolean): Promise<void>;
}

export type DispatchOutcome = 'SENT' | 'SKIPPED';

const SUPERSEDED = 'Not sent: the result changed before the email went out';
const OUTCOME_TEMPLATES = new Set<EmailTemplateKey>(['SHORTLISTED', 'REJECTED']);

/**
 * Delivers one dispatch. A row that is not QUEUED (already sent, or failed
 * earlier) is left alone, so a duplicate or stale job is a no-op. An outcome
 * email (Shortlisted / Not selected) whose candidate result has changed since it
 * was queued (re-decided, reopened, reset) is marked FAILED instead of sent.
 * Outcome emails copy the CC list from Integrations, read at send time (minus
 * the candidate's own address). A failed send is rethrown so the queue retries
 * it; only the final attempt marks the row FAILED.
 */
export function createDispatchProcessor(deps: {
  repo: DispatchRepository;
  sendEmail: (p: SendEmailParams) => Promise<void>;
  /** CC addresses for outcome emails (Integrations → Email). */
  outcomeCc?: () => Promise<string[]>;
}) {
  return async function process(dispatchId: string, opts: { finalAttempt: boolean }): Promise<DispatchOutcome> {
    const d = await deps.repo.findForSend(dispatchId);
    if (!d || d.status !== 'QUEUED') return 'SKIPPED';
    if (OUTCOME_TEMPLATES.has(d.template) && d.candidateResult !== d.template) {
      await deps.repo.recordFailure(d.id, SUPERSEDED, true);
      logger.info('email dispatch superseded', { dispatchId: d.id, template: d.template });
      return 'SKIPPED';
    }
    const to = d.toEmail.toLowerCase();
    const cc = OUTCOME_TEMPLATES.has(d.template) && deps.outcomeCc ? (await deps.outcomeCc()).filter((a) => a.toLowerCase() !== to) : [];
    try {
      await deps.sendEmail({ to: d.toEmail, subject: d.subject, html: d.html, text: d.text, ...(cc.length ? { cc } : {}) });
    } catch (err) {
      const message = (err instanceof Error ? err.message : 'Send failed').slice(0, MAX_ERROR_LENGTH);
      await deps.repo.recordFailure(d.id, message, opts.finalAttempt);
      logger.warn('email dispatch failed', { dispatchId: d.id, to: maskEmail(d.toEmail), final: opts.finalAttempt });
      throw err;
    }
    await deps.repo.markSent(d.id);
    logger.info('email dispatch sent', { dispatchId: d.id, to: maskEmail(d.toEmail) });
    return 'SENT';
  };
}
