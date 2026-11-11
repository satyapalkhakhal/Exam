// schemas/aiEvaluation.ts
// AI-assisted evaluation (docs/ai-evaluation.md). The AI only suggests marks;
// a human accepts or adjusts them through the normal marking flow, or a Super
// Admin bulk-accepts "clean" scripts. Composite scores mix the exam % with
// Class X / XII % and CPI by per-role weights (Super Admin only).

import { z } from 'zod';

const uuid = z.string().uuid();

// ---- OpenAI integration (Admin → Integrations) --------------------------------

export const AI_CONCURRENCY_MAX = 5;

/** apiKey: omitted/null keeps the stored key, '' clears it (same rule as other secrets). */
export const AiConfigInputSchema = z.object({
  enabled: z.boolean(),
  apiKey: z.string().trim().max(500).nullable().optional(),
  /** OpenAI model id chosen by the admin, e.g. the org's preferred GPT model. */
  model: z.string().trim().max(100),
  concurrency: z.number().int().min(1).max(AI_CONCURRENCY_MAX).default(3),
  /** Optional extra grading instructions appended to the system prompt. */
  gradingInstructions: z.string().max(4_000).default(''),
});
export type AiConfigInput = z.input<typeof AiConfigInputSchema>;

export interface MaskedAiConfig {
  enabled: boolean;
  apiKey: { set: boolean; last4: string | null };
  model: string;
  concurrency: number;
  gradingInstructions: string;
}

// ---- Model output ---------------------------------------------------------------

export const AI_CONCERNS = ['OFF_TOPIC', 'TOO_SHORT', 'REPEATS_QUESTION', 'PROMPT_INJECTION', 'LIKELY_AI_GENERATED', 'INCOHERENT'] as const;
export type AiConcern = (typeof AI_CONCERNS)[number];
export const AI_CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AiConfidence = (typeof AI_CONFIDENCE)[number];

/** Exactly what the model must return per question (OpenAI Structured Outputs). */
export const AiGradeOutputSchema = z.object({
  marks: z.number(),
  rationale: z.string(),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  confidence: z.enum(AI_CONFIDENCE),
  concerns: z.array(z.enum(AI_CONCERNS)),
});
export type AiGradeOutput = z.infer<typeof AiGradeOutputSchema>;

// ---- Runs -------------------------------------------------------------------------

/** Either a whole role (only once its exam is over) or chosen submitted attempts. */
export const AiRunStartSchema = z
  .object({
    driveId: uuid.optional(),
    attemptIds: z.array(uuid).min(1).max(1_000).optional(),
    /** Re-grade questions that already have a DONE AI score. */
    force: z.boolean().optional(),
  })
  .refine((v) => (v.driveId ? 1 : 0) + (v.attemptIds ? 1 : 0) === 1, { message: 'Give either driveId or attemptIds' });
export type AiRunStartInput = z.infer<typeof AiRunStartSchema>;

export const AiRunListQuerySchema = z.object({ driveId: uuid.optional() });
export const AiRunIdParamsSchema = z.object({ runId: uuid });

export type AiRunStatus = 'RUNNING' | 'DONE' | 'CANCELLED';

export interface AiRunDto {
  id: string;
  /** The whole drive graded; null for a run on chosen submissions. */
  drive: { id: string; displayName: string } | null;
  model: string;
  promptVersion: string;
  status: AiRunStatus;
  total: number;
  done: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  createdByName: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AiRunStartResultDto {
  /** null when there was nothing to grade. */
  run: AiRunDto | null;
  queued: number;
  /** Questions skipped because they already have a DONE score (force not set). */
  alreadyScored: number;
}

// ---- Scores shown to evaluators -----------------------------------------------------

export type AiScoreStatus = 'QUEUED' | 'DONE' | 'FAILED';

/** The latest AI score for one attempt question (blind: no candidate data). */
export interface AiQuestionScoreDto {
  id: string;
  status: AiScoreStatus;
  marks: number | null;
  maxMarks: number;
  rationale: string | null;
  strengths: string[];
  improvements: string[];
  confidence: AiConfidence | null;
  concerns: AiConcern[];
  model: string;
  error: string | null;
  completedAt: string | null;
}

/** Roll-up per attempt: NONE = never run, PARTIAL = some questions missing/failed/queued. */
export type AiAttemptState = 'NONE' | 'PARTIAL' | 'DONE';

export interface AiAttemptSummaryDto {
  state: AiAttemptState;
  /** Set only when state is DONE. */
  totalMarks: number | null;
  percentage: number | null;
  /** Any question with concerns or LOW confidence. */
  needsReview: boolean;
}

// ---- Bulk accept -------------------------------------------------------------------

export const AiAcceptSchema = z
  .object({
    driveId: uuid.optional(),
    attemptIds: z.array(uuid).min(1).max(1_000).optional(),
    /** Default true: skip scripts with AI concerns, LOW confidence or integrity flags. */
    onlyClean: z.boolean().default(true),
  })
  .refine((v) => (v.driveId ? 1 : 0) + (v.attemptIds ? 1 : 0) === 1, { message: 'Give either driveId or attemptIds' });
export type AiAcceptInput = z.input<typeof AiAcceptSchema>;

export type AiAcceptSkipReason =
  | 'NOT_FOUND'
  | 'NOT_SUBMITTED'
  | 'ALREADY_EVALUATED'
  | 'LOCKED'
  | 'AI_INCOMPLETE'
  | 'AI_CONCERNS'
  | 'LOW_CONFIDENCE'
  | 'INTEGRITY_FLAGS';

export interface AiAcceptResultDto {
  accepted: number;
  skipped: { attemptId: string; candidateCode: string | null; reason: AiAcceptSkipReason }[];
}

// ---- Composite ------------------------------------------------------------------------

export const CompositeWeightsSchema = z
  .object({
    exam: z.number().int().min(0).max(100),
    x: z.number().int().min(0).max(100),
    xii: z.number().int().min(0).max(100),
    cpi: z.number().int().min(0).max(100),
  })
  .refine((w) => w.exam + w.x + w.xii + w.cpi === 100, { message: 'Weights must add up to 100' })
  .refine((w) => w.exam > 0, { message: 'The exam weight must be above 0', path: ['exam'] });
export type CompositeWeights = z.infer<typeof CompositeWeightsSchema>;
export const DEFAULT_COMPOSITE_WEIGHTS: CompositeWeights = { exam: 70, x: 10, xii: 10, cpi: 10 };

export interface CompositeInput {
  /** Exam % (human-confirmed, else AI) or null when neither exists. */
  examPercentage: number | null;
  xPercentage: number | null;
  xiiPercentage: number | null;
  /** On a 10-point scale; scaled ×10. */
  majorCpi: number | null;
}

/**
 * Weighted composite over the components that are present; a missing
 * component's weight is re-spread over the rest. null when there is no exam %.
 * Rounded to 2 decimals.
 */
export function compositeScore(input: CompositeInput, w: CompositeWeights): number | null {
  if (input.examPercentage === null) return null;
  const parts: [number | null, number][] = [
    [input.examPercentage, w.exam],
    [input.xPercentage, w.x],
    [input.xiiPercentage, w.xii],
    [input.majorCpi === null ? null : input.majorCpi * 10, w.cpi],
  ];
  let sum = 0;
  let weight = 0;
  for (const [value, wt] of parts) {
    if (value === null || wt === 0) continue;
    sum += Math.min(100, Math.max(0, value)) * wt;
    weight += wt;
  }
  return weight === 0 ? null : Math.round((sum / weight) * 100) / 100;
}

export const LEADERBOARD_SORTS = ['human', 'composite', 'ai'] as const;
export type LeaderboardSort = (typeof LEADERBOARD_SORTS)[number];
