// schemas/evaluation.ts
// Zod contracts and DTOs for marking, decisions, the leaderboard and the
// dashboard (design §8, §9). Evaluator DTOs carry no candidate identity: the
// PII block is optional and the API adds it only for a Super Admin.

import { z } from 'zod';
import { CANDIDATE_BULK_MAX, type CandidateResult } from './candidates.js';
import { NextRoundSchema, type EmailSendResultDto } from './emails.js';
import { LEADERBOARD_SORTS, type AiAttemptSummaryDto, type AiQuestionScoreDto } from './aiEvaluation.js';

/** Submissions filter on the AI roll-up; NEEDS_REVIEW = AI done with concerns or LOW confidence. */
export const AI_FILTERS = ['NONE', 'PARTIAL', 'DONE', 'NEEDS_REVIEW'] as const;

export const EVALUATION_STATES = ['PENDING', 'DRAFT', 'SUBMITTED'] as const;
export type EvaluationState = (typeof EVALUATION_STATES)[number];

/** A soft lock lapses after this long without a lock refresh or a save. */
export const EVALUATION_LOCK_MINUTES = 30;
export const MARKS_STEP = 0.5;

const uuid = z.string().uuid();
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(25);

export const SubmissionListQuerySchema = z.object({
  jobRoleId: uuid.optional(),
  evaluation: z.enum(EVALUATION_STATES).optional(),
  ai: z.enum(AI_FILTERS).optional(),
  search: z.string().trim().max(100).optional(),
  page,
  pageSize,
});
export type SubmissionListQuery = z.infer<typeof SubmissionListQuerySchema>;

export const AttemptIdParamsSchema = z.object({ attemptId: uuid });

export const EvaluationItemSchema = z.object({
  attemptQuestionId: uuid,
  /** null = not marked yet; only allowed on a draft save. */
  marks: z.number().finite().nullable(),
  /** Omitted keeps the stored comment; null or "" clears it. */
  comment: z.string().trim().max(2000).nullable().optional(),
});

export const EvaluationSaveSchema = z
  .object({ items: z.array(EvaluationItemSchema).max(200), submit: z.boolean() })
  .refine((v) => new Set(v.items.map((i) => i.attemptQuestionId)).size === v.items.length, {
    message: 'Each question may appear once',
    path: ['items'],
  });
export type EvaluationSaveInput = z.infer<typeof EvaluationSaveSchema>;

export const ReopenSchema = z.object({ reason: z.string().trim().min(1).max(500) });

export const DECISIONS = ['SHORTLISTED', 'REJECTED'] as const;
export const DecisionSchema = z.object({
  decision: z.enum(DECISIONS),
  comment: z.string().trim().max(500).optional(),
});
export type DecisionInput = z.infer<typeof DecisionSchema>;

/**
 * Shortlist or reject several applications at once (Candidates page, and the
 * Leaderboard with one id). With sendEmail the matching email is queued for the
 * candidates whose result actually changed.
 */
export const CandidateDecisionBulkSchema = z.object({
  candidateIds: z
    .array(z.string().uuid())
    .min(1, 'Select at least one candidate')
    .max(CANDIDATE_BULK_MAX, `At most ${CANDIDATE_BULK_MAX} candidates at a time`)
    .transform((ids) => [...new Set(ids)]),
  decision: z.enum(DECISIONS),
  comment: z.string().trim().max(500).optional(),
  sendEmail: z.boolean(),
  /** Used by SHORTLISTED emails only. */
  nextRound: NextRoundSchema.optional(),
});
export type CandidateDecisionBulkInput = z.infer<typeof CandidateDecisionBulkSchema>;

export type DecisionSkipReason = 'NOT_FOUND' | 'NOT_EVALUATED' | 'ALREADY_DECIDED';

export interface CandidateDecisionBulkResultDto {
  updated: number;
  emailsQueued: number;
  /** Set when the results were saved but the emails could not be queued. */
  emailError: string | null;
  skipped: { candidateId: string; candidateCode: string | null; fullName: string | null; reason: DecisionSkipReason }[];
  emailSkipped: EmailSendResultDto['skipped'];
}

export const LeaderboardQuerySchema = z.object({ jobRoleId: uuid, sort: z.enum(LEADERBOARD_SORTS).default('human') });
export const ExportQuerySchema = z.object({ jobRoleId: uuid.optional() });

export interface CandidatePiiDto {
  candidateId: string;
  fullName: string;
  email: string;
  rollNumber: string | null;
  majorCpi: number | null;
  xPercentage: number | null;
  xiiPercentage: number | null;
  programme: string | null;
  discipline: string | null;
}

export interface SubmissionViewDto extends Partial<CandidatePiiDto> {
  attemptId: string;
  candidateCode: string;
  jobRole: string;
  submittedAt: string | null;
  timeTakenSec: number | null;
  submitType: 'MANUAL' | 'AUTO' | null;
  flagCounts: Record<string, number>;
  evaluationStatus: EvaluationState;
  totalMarks: number | null;
  /** AI roll-up (visible to Evaluators too: no candidate data). */
  ai: AiAttemptSummaryDto;
}

export interface MarkingQuestionDto {
  attemptQuestionId: string;
  order: number;
  text: string;
  maxMarks: number;
  evaluatorGuidance: string | null;
  answer: { text: string; wordCount: number; versions: { savedAt: string; wordCount: number }[] };
  integrity: { pasteAttempts: number; bulkInsert: { at: string; grown: number; typed: number }[] };
  evaluation: { marks: number | null; comment: string | null };
  /** Latest AI suggestion for this question, or null if never graded. */
  ai: AiQuestionScoreDto | null;
  /** True when the stored human mark was accepted unchanged from the AI score. */
  acceptedFromAi: boolean;
}

/**
 * One event from the candidate's exam, for the marking screen's timeline. Built from a
 * whitelist of event types; never carries IPs, devices or other raw metadata (blind marking).
 */
export interface TimelineEventDto {
  at: string;
  type: string;
  /** The question open when it happened, when the event names one. */
  questionOrder: number | null;
  /** Only for SUSPICIOUS_BULK_INSERT: characters the answer grew by vs characters typed. */
  bulk: { grown: number; typed: number } | null;
}

export interface MarkingViewDto extends SubmissionViewDto {
  startedAt: string;
  questions: MarkingQuestionDto[];
  timeline: TimelineEventDto[];
}

export interface LockDto {
  lockedBy: { id: string; name: string };
  lockedAt: string;
}

export interface LeaderboardRowDto extends CandidatePiiDto {
  rank: number;
  candidateCode: string;
  status: string;
  result: CandidateResult | null;
  submittedAt: string | null;
  totalMarks: number;
  maxMarks: number;
  percentage: number;
  questionMarks: { order: number; marks: number | null; aiMarks: number | null; maxMarks: number }[];
  /** AI exam % when every question has an AI score. */
  aiPercentage: number | null;
  /** Weighted composite (exam %, X, XII, CPI); null when no exam % exists. */
  compositeScore: number | null;
  /** The exam % inside the composite is the AI % (no submitted human evaluation yet). */
  compositeProvisional: boolean;
  flagCounts: Record<string, number>;
}

export interface DashboardRoleDto {
  jobRoleId: string;
  jobRoleName: string;
  refApplicantCount: number;
  imported: number;
  notStarted: number;
  inProgress: number;
  submitted: number;
  autoSubmitted: number;
  evaluated: number;
  shortlisted: number;
  rejected: number;
  pendingEvaluation: number;
}
