// modules/emails/emails.service.ts
// Editable candidate email templates and manual, queued sending
// (docs/email-templates.md). Templates are { subject, body } rows in
// system_config; no row (or a reset one) means the built-in default. Sending
// renders each email with the current template, stores it as a QUEUED
// dispatch in one transaction and hands one job per dispatch to the queue; the
// worker (createDispatchProcessor) delivers it. Everything is injected so the
// rules are testable without Postgres, Redis or a mail provider.

import path from 'node:path';
import type {
  EmailAttachmentDto,
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
  JobProfileType,
} from '@exam/shared';
import { ATTACHMENT_TEMPLATES, EMAIL_ATTACHMENT_TYPES, EMAIL_TEMPLATE_KEYS, EMAIL_TEMPLATE_PLACEHOLDERS } from '@exam/shared';
import { AppError, badRequest, conflict, unauthorized } from '../../shared/errors.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { maskEmail } from '../../shared/utils/piiMask.js';
import {
  DEFAULT_EMAIL_TEMPLATES,
  DEFAULT_HR_CONTACT,
  buildAssignmentEmail,
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
const SAMPLE = { fullName: 'Ajith K K', candidateCode: 'ARC-0042', fallbackRole: 'Backend Engineer', attachmentName: 'Round 2 assignment.pdf' } as const;
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
  jobProfileType: JobProfileType;
  /** The candidate's round, only when the job profile has more than one round (else null). */
  roundNumber: number | null;
  /** The current (non-RESET) attempt, if any. */
  attempt: {
    status: string;
    startedAt: Date | null;
    submittedAt: Date | null;
    submitType: 'MANUAL' | 'AUTO' | null;
    answeredCount: number;
    questionCount: number;
  } | null;
}

export interface NewDispatch {
  template: EmailTemplateKey;
  candidateId: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
  attachmentId?: string;
}

export interface NewAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  content: Buffer;
  uploadedById: string;
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
  attachmentName: string | null;
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
  createAttachment(a: NewAttachment): Promise<EmailAttachmentDto>;
  /** Metadata only (never the content). */
  findAttachment(id: string): Promise<EmailAttachmentDto | null>;
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

// Leading bytes per stored type: PDF, OLE2 (.doc), ZIP container (.docx/.xlsx/.pptx/.zip).
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const MAGIC: Record<string, number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'application/msword': [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
};
const startsWith = (buf: Buffer, sig: number[]): boolean => buf.length >= sig.length && sig.every((b, i) => buf[i] === b);

/**
 * Multer hands over the name as latin1; restore UTF-8, drop any path and control
 * characters, and cap the length (keeping the extension).
 */
export function cleanFileName(raw: string): string {
  const latin1Only = !/[^\u0000-\u00ff]/.test(raw);
  const utf8 = latin1Only ? Buffer.from(raw, 'latin1').toString('utf8') : raw;
  const name = (utf8.includes('\uFFFD') ? raw : utf8)
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .trim();
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length).slice(0, 150).trim();
  return `${stem || 'attachment'}${ext.toLowerCase()}`;
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
    };
    if (key === 'SUBMISSION_RECEIVED') return buildSubmissionEmail({ ...base, submittedAt: new Date(), submitType: 'MANUAL', answeredCount: 2, questionCount: 3 }, template);
    if (key === 'REJECTED') return buildRejectionEmail(base, template);
    if (key === 'ASSIGNMENT') return buildAssignmentEmail({ ...base, attachmentName: input.attachmentName || SAMPLE.attachmentName }, template);
    const now = Date.now();
    const sample: AssessmentSummary = {
      startedAt: new Date(now - 52.5 * 60_000),
      submittedAt: new Date(now),
      submitType: 'MANUAL',
      answeredCount: 8,
      questionCount: 10,
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

  function render(
    key: EmailTemplateKey,
    c: EmailCandidate,
    template: EmailTemplate,
    contactEmail: string,
    nextRound: NextRoundDetails | undefined,
    attachmentName: string,
  ): EmailContent {
    const base = { fullName: c.fullName, candidateCode: c.candidateCode, jobRoleName: c.jobRoleName, jobProfileType: c.jobProfileType, roundNumber: c.roundNumber, contactEmail };
    if (key === 'SHORTLISTED') {
      const a = c.attempt;
      const assessment: AssessmentSummary | undefined = a
        ? { startedAt: a.startedAt, submittedAt: a.submittedAt, submitType: a.submitType, answeredCount: a.answeredCount, questionCount: a.questionCount }
        : undefined;
      return buildShortlistEmail({ ...base, nextRound, assessment }, template);
    }
    if (key === 'REJECTED') return buildRejectionEmail(base, template);
    if (key === 'ASSIGNMENT') return buildAssignmentEmail({ ...base, attachmentName }, template);
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
    if ((key === 'SHORTLISTED' || key === 'ASSIGNMENT') && c.result !== 'SHORTLISTED') return 'NOT_SHORTLISTED';
    if (key === 'REJECTED' && c.result !== 'REJECTED') return 'NOT_REJECTED';
    return alreadySent ? 'ALREADY_SENT' : null;
  }

  async function send(input: EmailSendInput, adminId: string): Promise<EmailSendResultDto> {
    const cfg = await deps.getEmailConfig();
    if (!deps.isChannelReady(cfg)) throw conflict(NOT_CONFIGURED, 'EMAIL_NOT_CONFIGURED');

    const needsFile = ATTACHMENT_TEMPLATES.includes(input.template);
    if (needsFile && !input.attachmentId) throw badRequest('Attach the assignment file before sending');
    if (!needsFile && input.attachmentId) throw badRequest('This email does not take an attachment');
    const attachment = input.attachmentId ? await repo.findAttachment(input.attachmentId) : null;
    if (input.attachmentId && !attachment) throw badRequest('The attached file was not found. Upload it again.');

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
      rows.push({
        template: input.template,
        candidateId: id,
        toEmail: c.email,
        ...render(input.template, c, template, contact, nextRound, attachment?.fileName ?? ''),
        ...(attachment ? { attachmentId: attachment.id } : {}),
      });
    }
    if (rows.length === 0) return { batchId, queued: 0, skipped };

    const dispatchIds = await repo.createDispatches(batchId, adminId, rows, {
      adminId,
      action: 'EMAILS_QUEUED',
      entity: 'email_dispatch',
      entityId: batchId,
      metadata: { template: input.template, count: rows.length, batchId, ...(attachment ? { attachmentId: attachment.id } : {}) },
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
      items: items.map((r) => ({ ...r, toEmail: maskEmail(r.toEmail), createdAt: r.createdAt.toISOString(), sentAt: r.sentAt ? r.sentAt.toISOString() : null })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** Stores a file for an Assignment send. The extension was checked on upload; the content must match it. */
  async function uploadAttachment(file: { buffer: Buffer; originalname: string; size: number } | undefined, adminId: string): Promise<EmailAttachmentDto> {
    if (!file || file.size === 0) throw badRequest('Choose a file to attach');
    const fileName = cleanFileName(file.originalname);
    const mimeType = EMAIL_ATTACHMENT_TYPES[path.extname(fileName)];
    if (!mimeType) throw badRequest('This file type cannot be attached');
    const sig = MAGIC[mimeType] ?? ZIP;
    if (!startsWith(file.buffer, sig)) throw badRequest('The file content does not match its extension');
    const saved = await repo.createAttachment({ fileName, mimeType, size: file.size, content: file.buffer, uploadedById: adminId });
    await deps.audit({ adminId, action: 'EMAIL_ATTACHMENT_UPLOADED', entity: 'email_attachment', entityId: saved.id, metadata: { size: saved.size, mimeType } });
    return saved;
  }

  return { listTemplates, saveTemplate, resetTemplate, renderPreview, sendTest, send, listDispatches, uploadAttachment };
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
  attachment: { name: string; mimeType: string; content: Buffer } | null;
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
/** Copied to the CC list from Integrations. */
const OUTCOME_TEMPLATES = new Set<EmailTemplateKey>(['SHORTLISTED', 'REJECTED', 'ASSIGNMENT']);
/** The result a candidate must still have when the email goes out. */
const REQUIRED_RESULT: Partial<Record<EmailTemplateKey, 'SHORTLISTED' | 'REJECTED'>> = {
  SHORTLISTED: 'SHORTLISTED',
  REJECTED: 'REJECTED',
  ASSIGNMENT: 'SHORTLISTED',
};

/**
 * Delivers one dispatch. A row that is not QUEUED (already sent, or failed
 * earlier) is left alone, so a duplicate or stale job is a no-op. An outcome
 * email (Shortlisted / Not selected / Assignment) whose candidate result no longer
 * fits (re-decided, reopened, reset) is marked FAILED instead of sent. An
 * Assignment dispatch carries its stored file as an attachment.
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
    const required = REQUIRED_RESULT[d.template];
    if (required && d.candidateResult !== required) {
      await deps.repo.recordFailure(d.id, SUPERSEDED, true);
      logger.info('email dispatch superseded', { dispatchId: d.id, template: d.template });
      return 'SKIPPED';
    }
    const to = d.toEmail.toLowerCase();
    const cc = OUTCOME_TEMPLATES.has(d.template) && deps.outcomeCc ? (await deps.outcomeCc()).filter((a) => a.toLowerCase() !== to) : [];
    try {
      await deps.sendEmail({
        to: d.toEmail,
        subject: d.subject,
        html: d.html,
        text: d.text,
        ...(cc.length ? { cc } : {}),
        ...(d.attachment ? { attachments: [d.attachment] } : {}),
      });
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
