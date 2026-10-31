// schemas/evaluation.ts
// Zod contracts and DTOs for marking, decisions, the leaderboard and the
// dashboard (design §8, §9). Evaluator DTOs carry no candidate identity: the
// PII block is optional and the API adds it only for a Super Admin.

import { z } from 'zod';

export const EVALUATION_STATES = ['PENDING', 'DRAFT', 'SUBMITTED'] as const;
export type EvaluationState = (typeof EVALUATION_STATES)[number];

/** A soft lock lapses after this long without a lock refresh or a save. */
export const EVALUATION_LOCK_MINUTES = 30;
export const MARKS_STEP = 0.5;

const uuid = z.string().uuid();
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(25);

export const SubmissionListQuerySchema = z.object({
  roundId: uuid.optional(),
  examId: uuid.optional(),
  jobRoleId: uuid.optional(),
  evaluation: z.enum(EVALUATION_STATES).optional(),
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

export const LeaderboardQuerySchema = z.object({ roundId: uuid });
export const ExportQuerySchema = z.object({ roundId: uuid.optional() });

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
  examName: string;
  roundNumber: number;
  submittedAt: string | null;
  timeTakenSec: number | null;
  submitType: 'MANUAL' | 'AUTO' | null;
  flagCounts: Record<string, number>;
  evaluationStatus: EvaluationState;
  totalMarks: number | null;
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
  submittedAt: string | null;
  totalMarks: number;
  maxMarks: number;
  percentage: number;
  questionMarks: { order: number; marks: number | null; maxMarks: number }[];
  flagCounts: Record<string, number>;
}

export interface DashboardRoundDto {
  examId: string;
  examName: string;
  jobRoleName: string;
  roundId: string;
  roundNumber: number;
  /** Candidates holding an entry in this round. */
  entered: number;
  notStarted: number;
  inProgress: number;
  submitted: number;
  autoSubmitted: number;
  pendingEvaluation: number;
  evaluated: number;
  shortlisted: number;
  rejected: number;
}
