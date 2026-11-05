// schemas/candidates.ts
// Zod contracts and DTOs for candidate management, shared by the API and the
// admin forms. normalizeMobile lives here so the import parser and the edit
// form accept exactly the same mobile formats (design §6.1).

import { z } from 'zod';

/** Exam progress, the only statuses written since results moved to their own column. */
export const CANDIDATE_PROGRESS_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'] as const;
/** Every DB value: SHORTLISTED / REJECTED survive only on old history rows. */
const CANDIDATE_STATUSES = [...CANDIDATE_PROGRESS_STATUSES, 'SHORTLISTED', 'REJECTED'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** HR's outcome for an application, kept apart from its exam progress (status). */
export const CANDIDATE_RESULTS = ['SHORTLISTED', 'REJECTED'] as const;
export type CandidateResult = (typeof CANDIDATE_RESULTS)[number];

/** Strips a +91 / 91 / 0 prefix and separators; null unless 10 digits starting 6-9. */
export function normalizeMobile(raw: string): string | null {
  let s = raw.replace(/[\s\-()]/g, '');
  if (s.startsWith('+91')) s = s.slice(3);
  else if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return /^[6-9]\d{9}$/.test(s) ? s : null;
}

/** Length caps shared by the edit form and the import parser. */
export const CANDIDATE_NAME_MAX = 150;
export const CANDIDATE_TEXT_MAX = 200;

const name = z.string().trim().min(2).max(CANDIDATE_NAME_MAX);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254)
  // The API only ever shows masked addresses (a****z@x); one must never be saved back.
  .refine((v) => !v.includes('*'), 'Click Show to see and edit the full email');
const mobile = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const m = normalizeMobile(v);
    if (m === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a 10-digit Indian mobile number' });
    return m ?? '';
  });
const optText = z.string().trim().max(CANDIDATE_TEXT_MAX).nullable();
const pct = z.number().min(0).max(100).nullable();
const cpi = z.number().min(0).max(10).nullable();

// One candidate added by hand from the admin panel; same fields and rules as an import row.
export const CandidateCreateSchema = z.object({
  fullName: name,
  email,
  mobile: mobile.nullable().optional(),
  rollNumber: optText.optional(),
  xPercentage: pct.optional(),
  xiiPercentage: pct.optional(),
  majorCpi: cpi.optional(),
  discipline: optText.optional(),
  programme: optText.optional(),
  jobRoleId: z.string().uuid(),
});
export type CandidateCreateInput = z.infer<typeof CandidateCreateSchema>;

// Multipart form fields arrive as strings. updateExisting=true lets the import move
// existing (not yet started) candidates to the chosen job profile and refresh their details.
export const CandidateImportPreviewBodySchema = z.object({
  jobRoleId: z.string().uuid(),
  updateExisting: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type CandidateImportPreviewBody = z.infer<typeof CandidateImportPreviewBodySchema>;

export const CandidateUpdateSchema = z
  .object({
    fullName: name.optional(),
    email: email.optional(),
    mobile: mobile.nullable().optional(),
    rollNumber: optText.optional(),
    xPercentage: pct.optional(),
    xiiPercentage: pct.optional(),
    majorCpi: cpi.optional(),
    discipline: optText.optional(),
    programme: optText.optional(),
    jobRoleId: z.string().uuid().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type CandidateUpdateInput = z.infer<typeof CandidateUpdateSchema>;

/** Move several candidates to one job role at once (only those who have not started). */
export const CANDIDATE_BULK_MAX = 1000;
export const CandidateBulkJobRoleSchema = z.object({
  candidateIds: z
    .array(z.string().uuid())
    .min(1, 'Select at least one candidate')
    .max(CANDIDATE_BULK_MAX, `At most ${CANDIDATE_BULK_MAX} candidates at a time`)
    .transform((ids) => [...new Set(ids)]),
  jobRoleId: z.string().uuid(),
});
export type CandidateBulkJobRoleInput = z.infer<typeof CandidateBulkJobRoleSchema>;

export interface CandidateBulkJobRoleResultDto {
  updated: number;
  skipped: { candidateId: string; candidateCode: string | null; fullName: string | null; reason: 'STARTED' | 'SAME_ROLE' | 'NOT_FOUND' | 'SAME_PERSON_HAS_ROLE' }[];
}

export const CandidateEligibilitySchema = z.object({ eligible: z.boolean() });
export const CandidateLocationExemptSchema = z.object({
  exempt: z.boolean(),
  reason: z.string().trim().min(3).max(500),
});
export const CandidateResetSchema = z.object({ reason: z.string().trim().min(10).max(500) });

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const CANDIDATE_SORT_KEYS = ['fullName', 'majorCpi', 'xPercentage', 'xiiPercentage', 'createdAt', 'timeTaken', 'marks'] as const;
/** Result filter: NONE = no decision yet. */
export const CANDIDATE_RESULT_FILTERS = ['SHORTLISTED', 'REJECTED', 'NONE'] as const;
const pctMin = z.coerce.number().min(0).max(100).optional();
export const CandidateListQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  jobRoleId: z.string().uuid().optional(),
  status: z.enum(CANDIDATE_PROGRESS_STATUSES).optional(),
  result: z.enum(CANDIDATE_RESULT_FILTERS).optional(),
  flagged: bool.optional(),
  /** Minimums: a row with no value in that column is excluded once a minimum is set. */
  xMin: pctMin,
  xiiMin: pctMin,
  cpiMin: z.coerce.number().min(0).max(10).optional(),
  /** Exam marks as a percentage of max marks; only evaluated attempts have one. */
  marksPctMin: pctMin,
  sort: z.enum(CANDIDATE_SORT_KEYS).default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type CandidateListQuery = z.infer<typeof CandidateListQuerySchema>;

export const CandidateDetailQuerySchema = z.object({
  activityPage: z.coerce.number().int().min(1).default(1),
});
export type CandidateDetailQuery = z.infer<typeof CandidateDetailQuerySchema>;

export interface CandidateRowDto {
  id: string;
  candidateCode: string;
  fullName: string;
  email: string;
  mobile: string | null;
  rollNumber: string | null;
  xPercentage: number | null;
  xiiPercentage: number | null;
  majorCpi: number | null;
  discipline: string | null;
  programme: string | null;
  jobRoleId: string;
  jobRoleName: string;
  status: CandidateStatus;
  result: CandidateResult | null;
  eligible: boolean;
  locationExempt: boolean;
  flagCount: number;
  createdAt: string;
}

/** The current (non-reset) attempt of a list row. Marks stay null until its evaluation is submitted. */
export interface CandidateExamStatsDto {
  startedAt: string;
  submittedAt: string | null;
  answeredCount: number;
  questionCount: number;
  totalMarks: number | null;
  maxMarks: number;
  percentage: number | null;
}

export interface CandidateListItemDto extends CandidateRowDto {
  exam: CandidateExamStatsDto | null;
  /** The same person's other applications (other job profiles). */
  otherApplications: { jobRoleName: string; status: CandidateStatus; result: CandidateResult | null }[];
}

/** Every candidate matching the list filters (for "select all matching"), capped at CANDIDATE_BULK_MAX. */
export interface CandidateMatchingIdsDto {
  ids: string[];
  total: number;
  jobRoleIdById: Record<string, string>;
}

export interface CandidateLoginLogDto {
  id: string;
  kind: 'LOGIN' | 'START';
  createdAt: string;
  permission: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  ip: string;
  browser: string;
  os: string;
  deviceType: string;
}

/** The exam engine's review evidence (design §7.2a, §7.4); signals for HR, never a verdict. */
export interface CandidateFlagsDto {
  integrity: { pasteAttempts: number; bulkInsert: number; tabHidden: number; blur: number; ipChanges: number };
  location: (
    | { code: 'LOGIN_START_DISTANCE'; km: number }
    | { code: 'NEARBY_CANDIDATES'; withCandidateIds: string[]; meters: number }
    | { code: 'SHARED_IP'; ip: string; count: number }
  )[];
}

export interface CandidateDetailDto {
  candidate: CandidateRowDto & { extra: Record<string, string> };
  loginLogs: CandidateLoginLogDto[];
  attempt: { id: string; status: string; startedAt: string; submittedAt: string | null } | null;
  activity: { items: { id: string; type: string; createdAt: string; detail: unknown }[]; total: number; page: number; pageSize: number };
  flags: CandidateFlagsDto;
  /** The same person's other applications (same account), excluding this one. */
  otherApplications: { id: string; candidateCode: string; jobRole: { id: string; name: string }; status: string; result: CandidateResult | null }[];
  /** A row whose fromResult differs from toResult is a result change (decision, or cleared by a reopen/reset). */
  history: {
    id: string; fromStatus: string | null; toStatus: string; fromResult: CandidateResult | null; toResult: CandidateResult | null;
    reason: string | null; actorName: string | null; createdAt: string;
  }[];
}

export interface CandidateImportRow {
  row: number;
  fullName: string;
  email: string;
  mobile: string | null;
  rollNumber: string | null;
}
