// src/lib/aiEvaluation.ts
// Why: the AI-evaluation UI (docs/ai-evaluation.md) keeps its wording and small decisions
// here as pure functions so they are tested and the components stay thin: state badges,
// plain-word skip reasons, concern labels, the "fill drafts from AI" mapping, composite
// weight validation and run-progress helpers. AI only ever suggests; nothing here saves marks.

import {
  CompositeWeightsSchema,
  type AiAcceptSkipReason,
  type AiAttemptSummaryDto,
  type AiConcern,
  type AiConfidence,
  type AiQuestionScoreDto,
  type AiRunDto,
  type CompositeWeights,
} from '@exam/shared';

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

/** Badge text/variant for the Submissions "AI" column. */
export function aiStateBadge(ai: AiAttemptSummaryDto): { label: string; variant: BadgeVariant } {
  if (ai.state === 'NONE') return { label: 'Not run', variant: 'outline' };
  if (ai.state === 'PARTIAL') return { label: 'Partial', variant: 'secondary' };
  return ai.needsReview ? { label: 'Needs review', variant: 'destructive' } : { label: 'Done', variant: 'default' };
}

export const AI_FILTER_LABEL = { NONE: 'Not run', PARTIAL: 'Partial', DONE: 'Done', NEEDS_REVIEW: 'Needs review' } as const;

export const CONCERN_LABEL: Record<AiConcern, string> = {
  OFF_TOPIC: 'Off topic',
  TOO_SHORT: 'Too short',
  REPEATS_QUESTION: 'Repeats the question',
  PROMPT_INJECTION: 'Tries to instruct the AI',
  LIKELY_AI_GENERATED: 'Looks AI-written',
  INCOHERENT: 'Incoherent',
};

export const CONFIDENCE_LABEL: Record<AiConfidence, string> = { LOW: 'Low confidence', MEDIUM: 'Medium confidence', HIGH: 'High confidence' };

export const SKIP_REASON_LABEL: Record<AiAcceptSkipReason, string> = {
  NOT_FOUND: 'Submission not found',
  NOT_SUBMITTED: 'Exam not submitted yet',
  ALREADY_EVALUATED: 'Already evaluated',
  LOCKED: 'Being marked by someone else',
  AI_INCOMPLETE: 'AI has not scored every question',
  AI_CONCERNS: 'AI raised concerns',
  LOW_CONFIDENCE: 'AI had low confidence',
  INTEGRITY_FLAGS: 'Has integrity flags',
};

/** Counts skipped scripts per reason, most frequent first. */
export function summariseSkips(skipped: { reason: AiAcceptSkipReason }[]): { reason: AiAcceptSkipReason; label: string; count: number }[] {
  const counts = new Map<AiAcceptSkipReason, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, label: SKIP_REASON_LABEL[reason], count }))
    .sort((a, b) => b.count - a.count);
}

/** Friendly copy for the API errors this feature adds; null falls back to the server message. */
export function aiErrorMessage(code: string | undefined): { text: string; linkToIntegrations: boolean } | null {
  if (code === 'AI_NOT_CONFIGURED') return { text: 'AI evaluation is not set up yet. Add the OpenAI key and model in', linkToIntegrations: true };
  if (code === 'EXAM_NOT_OVER') return { text: 'This drive is still open or someone is still taking it.', linkToIntegrations: false };
  if (code === 'MIXED_DRIVES') return { text: 'Select submissions from one drive.', linkToIntegrations: false };
  return null;
}

/** True when the chosen rows come from more than one drive (spec 2026-11-10: AI runs and bulk accept are per drive). */
export function selectionSpansDrives(driveNames: Array<string | undefined>): boolean {
  return new Set(driveNames.filter((n): n is string => Boolean(n))).size > 1;
}

interface DraftLike {
  marks: string;
  comment: string;
}

/** The AI marks that can be used: only DONE scores with a numeric mark. */
export function usableAiMarks(ai: AiQuestionScoreDto | null): number | null {
  return ai && ai.status === 'DONE' && ai.marks !== null ? ai.marks : null;
}

/** Fills marks from DONE AI scores (all questions, or just `only`), keeping comments and other questions. */
export function fillDraftsFromAi<D extends DraftLike>(
  drafts: Record<string, D>,
  questions: { attemptQuestionId: string; ai: AiQuestionScoreDto | null }[],
  only?: string,
): Record<string, DraftLike> {
  const next: Record<string, DraftLike> = { ...drafts };
  for (const q of questions) {
    if (only !== undefined && q.attemptQuestionId !== only) continue;
    const marks = usableAiMarks(q.ai);
    if (marks === null) continue;
    next[q.attemptQuestionId] = { comment: drafts[q.attemptQuestionId]?.comment ?? '', marks: String(marks) };
  }
  return next;
}

export const countAiUsable = (questions: { ai: AiQuestionScoreDto | null }[]): number => questions.filter((q) => usableAiMarks(q.ai) !== null).length;

// ---- Composite weights ------------------------------------------------------------------

export const WEIGHT_KEYS = ['exam', 'x', 'xii', 'cpi'] as const;

/** Sum of the typed weights; blanks/NaN count as 0. */
export function weightsSum(w: Record<(typeof WEIGHT_KEYS)[number], number>): number {
  return WEIGHT_KEYS.reduce((t, k) => t + (Number.isFinite(w[k]) ? w[k] : 0), 0);
}

/** Null when valid, else the first plain-language problem (same rules as the server schema). */
export function weightsError(w: Record<(typeof WEIGHT_KEYS)[number], number>): string | null {
  if (WEIGHT_KEYS.some((k) => !Number.isInteger(w[k]))) return 'Enter whole numbers for every weight';
  const r = CompositeWeightsSchema.safeParse(w);
  if (r.success) return null;
  const sum = weightsSum(w);
  if (sum !== 100) return `Weights add up to ${sum}; they must add up to 100`;
  return r.error.issues[0]?.message ?? 'Invalid weights';
}

export const parseWeights = (w: Record<(typeof WEIGHT_KEYS)[number], number>): CompositeWeights => ({ exam: w.exam, x: w.x, xii: w.xii, cpi: w.cpi });

// ---- Runs --------------------------------------------------------------------------------

export const hasRunningRun = (runs: AiRunDto[] | undefined): boolean => Boolean(runs?.some((r) => r.status === 'RUNNING'));

/** Polling interval for the runs query: 3 s while anything runs, otherwise off. */
export const runsRefetchInterval = (runs: AiRunDto[] | undefined): number | false => (hasRunningRun(runs) ? 3000 : false);

export function runProgressLabel(r: Pick<AiRunDto, 'done' | 'failed' | 'total'>): string {
  const base = `${r.done} of ${r.total} done`;
  return r.failed > 0 ? `${base}, ${r.failed} failed` : base;
}

export const runPercent = (r: Pick<AiRunDto, 'done' | 'failed' | 'total'>): number =>
  r.total <= 0 ? 0 : Math.min(100, Math.round(((r.done + r.failed) / r.total) * 100));

export const formatTokens = (n: number): string => n.toLocaleString('en-IN');

/** Leaderboard: show the "provisional" hint only when a composite exists and rests on AI marks. */
export const isProvisional = (r: { compositeScore: number | null; compositeProvisional: boolean }): boolean => r.compositeScore !== null && r.compositeProvisional;
