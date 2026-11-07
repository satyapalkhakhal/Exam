// schemas/emails.ts
// Candidate email templates and manual sending from the admin panel
// (docs/email-templates.md). Super Admin only. Templates are editable text
// (subject + body with {placeholders}); the branded layout, details table,
// link button and instruction list are added by the API. Sending is queued
// and every send is recorded as an email dispatch.

import { z } from 'zod';

export const EMAIL_TEMPLATE_KEYS = ['SUBMISSION_RECEIVED', 'SHORTLISTED', 'REJECTED'] as const;
export const EmailTemplateKeySchema = z.enum(EMAIL_TEMPLATE_KEYS);
export type EmailTemplateKey = z.infer<typeof EmailTemplateKeySchema>;

/** Placeholders every template accepts. */
export const COMMON_EMAIL_PLACEHOLDERS = ['firstName', 'fullName', 'role', 'candidateCode', 'contactEmail'] as const;
/** Extra placeholders per template. */
export const EMAIL_TEMPLATE_PLACEHOLDERS: Record<EmailTemplateKey, readonly string[]> = {
  SUBMISSION_RECEIVED: [...COMMON_EMAIL_PLACEHOLDERS, 'submittedAt', 'answeredCount', 'questionCount'],
  SHORTLISTED: [...COMMON_EMAIL_PLACEHOLDERS, 'roundName', 'scheduledAt', 'confirmBy'],
  REJECTED: [...COMMON_EMAIL_PLACEHOLDERS],
};

export const EMAIL_SUBJECT_MAX = 200;
export const EMAIL_BODY_MAX = 5_000;

export const EmailTemplateKeyParamsSchema = z.object({ key: EmailTemplateKeySchema });

/** Unknown {placeholders} are rejected by the API (400 VALIDATION_ERROR) per template key. */
export const EmailTemplateUpdateSchema = z.object({
  subject: z.string().trim().min(1).max(EMAIL_SUBJECT_MAX),
  /** Plain text; a blank line starts a new paragraph. */
  body: z.string().trim().min(1).max(EMAIL_BODY_MAX),
});
export type EmailTemplateUpdateInput = z.infer<typeof EmailTemplateUpdateSchema>;

const isoDate = z.string().datetime({ offset: true });

export const NextRoundSchema = z.object({
  name: z.string().trim().max(120).optional(),
  mode: z.string().trim().max(120).optional(),
  scheduledAt: isoDate.optional(),
  venue: z.string().trim().max(300).optional(),
  link: z.string().trim().url().max(500).refine((v) => v.startsWith('https://'), 'The link must start with https://').optional(),
  linkLabel: z.string().trim().max(60).optional(),
  instructions: z.string().trim().max(2_000).optional(),
  confirmBy: isoDate.optional(),
});
export type NextRoundInput = z.infer<typeof NextRoundSchema>;

/** Preview with sample candidate data; subject/body default to the saved template. */
export const EmailPreviewSchema = z.object({
  subject: z.string().max(EMAIL_SUBJECT_MAX).optional(),
  body: z.string().max(EMAIL_BODY_MAX).optional(),
  nextRound: NextRoundSchema.optional(),
});
export type EmailPreviewInput = z.infer<typeof EmailPreviewSchema>;

export const EmailSendSchema = z.object({
  template: EmailTemplateKeySchema,
  candidateIds: z.array(z.string().uuid()).min(1).max(1_000),
  /** Used by SHORTLISTED only. */
  nextRound: NextRoundSchema.optional(),
  /** Send even to candidates who already have a QUEUED or SENT email of this template. */
  resend: z.boolean().optional(),
});
export type EmailSendInput = z.infer<typeof EmailSendSchema>;

export const EMAIL_DISPATCH_STATUSES = ['QUEUED', 'SENT', 'FAILED'] as const;
export type EmailDispatchStatus = (typeof EMAIL_DISPATCH_STATUSES)[number];

export const EmailDispatchListQuerySchema = z.object({
  candidateId: z.string().uuid().optional(),
  template: EmailTemplateKeySchema.optional(),
  status: z.enum(EMAIL_DISPATCH_STATUSES).optional(),
  batchId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type EmailDispatchListQuery = z.infer<typeof EmailDispatchListQuerySchema>;

export interface EmailTemplateDto {
  key: EmailTemplateKey;
  /** e.g. "Submission received". */
  name: string;
  description: string;
  subject: string;
  body: string;
  placeholders: { token: string; description: string }[];
  /** True while the template is the built-in default (never saved, or reset). */
  isDefault: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
}

export interface EmailRenderedDto {
  subject: string;
  html: string;
  text: string;
}

export type EmailSkipReason = 'NOT_FOUND' | 'INELIGIBLE' | 'NOT_SUBMITTED' | 'NOT_SHORTLISTED' | 'NOT_REJECTED' | 'ALREADY_SENT';

export interface EmailSendResultDto {
  batchId: string;
  queued: number;
  skipped: { candidateId: string; candidateCode: string | null; fullName: string | null; reason: EmailSkipReason }[];
}

export interface EmailDispatchDto {
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
  createdAt: string;
  sentAt: string | null;
}
