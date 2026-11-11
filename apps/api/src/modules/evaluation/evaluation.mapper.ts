// modules/evaluation/evaluation.mapper.ts
// Blind marking, enforced here (design §8): every DTO is built field by field
// from a whitelist, never by spreading a row, so a new column on the candidate
// or a stray metadata key cannot reach the Evaluator. Identity and academics
// are added only for a Super Admin; location (coordinates, IPs) is never
// included for anyone. Integrity evidence is reduced to counts and the
// bulk-insert numbers, never the raw activity metadata. The exam timeline is the
// same idea: whitelisted event types with time and question only (an IP change
// shows that it happened, never the addresses). AI scores are whitelisted the
// same way and are visible to Evaluators (no candidate data in them); the
// composite score mixes in academics, so it is never built here at all.

import { maskEmail } from '../../shared/utils/piiMask.js';
import { percentageOf } from './marks.js';
import { AI_CONCERNS, driveDisplayName, type JobProfileType } from '@exam/shared';
import type {
  AdminRole,
  AiAttemptSummaryDto,
  AiConcern,
  AiQuestionScoreDto,
  CandidatePiiDto,
  EvaluationState,
  MarkingQuestionDto,
  MarkingViewDto,
  SubmissionViewDto,
  TimelineEventDto,
} from '@exam/shared';

type Num = { toNumber(): number } | number | null;
export const num = (n: Num): number | null => (n === null ? null : typeof n === 'number' ? n : n.toNumber());

export interface CandidateSource {
  id: string;
  candidateCode: string;
  fullName: string;
  email: string;
  rollNumber: string | null;
  xPercentage: Num;
  xiiPercentage: Num;
  majorCpi: Num;
  programme: string | null;
  discipline: string | null;
  jobRole: { name: string; type: JobProfileType };
  /** College and batch reach a Super Admin only (as the drive name); never an Evaluator. */
  drive: { batch: string; round: { roundNumber: number }; college: { shortCode: string } };
}

/** One ai_question_scores row, as selected for display. */
export interface AiScoreSource {
  id: string;
  status: 'QUEUED' | 'DONE' | 'FAILED';
  marks: Num;
  maxMarks: Num;
  rationale: string | null;
  strengths: unknown;
  improvements: unknown;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  concerns: string[];
  model: string;
  error: string | null;
  completedAt: Date | null;
}

/** What the AI roll-up needs per question; scores are newest first. */
export interface AiRollupQuestion {
  /** Omitted by older callers/tests: treated as WRITTEN. MCQs are never AI-graded. */
  typeSnapshot?: 'WRITTEN' | 'MCQ';
  maxMarksSnapshot: Num;
  aiScores: AiScoreSource[];
}

export interface SubmissionSource {
  attemptId: string;
  startedAt: Date;
  submittedAt: Date | null;
  submitType: 'MANUAL' | 'AUTO' | null;
  totalMarks: Num;
  /** Omitted by older callers/tests: no MCQs. */
  mcqMarks?: Num;
  mcqMaxMarks?: Num;
  evaluation: { status: 'DRAFT' | 'SUBMITTED'; evaluatorId: string | null } | null;
  candidate: CandidateSource;
  flags: Record<string, number>;
  /** Omitted by older callers/tests: treated as no start location. */
  nearbyCount?: number | null;
  questions: AiRollupQuestion[];
}

export interface MarkingQuestionSource extends AiRollupQuestion {
  id: string;
  order: number;
  textSnapshot: string;
  /** MCQ snapshot (shown order); omitted/empty for written questions. */
  optionsSnapshot?: string[];
  correctSnapshot?: number | null;
  autoMarks?: Num;
  question: { evaluatorGuidance: string | null };
  answer: { text: string; wordCount: number; selectedOption?: number | null; versions: { savedAt: Date; wordCount: number }[] } | null;
  evaluation: { marks: Num; comment: string | null; aiScoreId: string | null } | null;
}

export interface ActivitySource {
  eventType: string;
  questionId: string | null;
  createdAt: Date;
  metadata: unknown;
}

export interface MarkingSource extends SubmissionSource {
  questions: MarkingQuestionSource[];
  activity: ActivitySource[];
}

const PASTE_EVENTS = new Set(['PASTE_ATTEMPT', 'COPY_ATTEMPT', 'CUT_ATTEMPT', 'DROP_ATTEMPT']);

/** Exam events shown on the marking timeline (login/OTP events stay on the candidate page). */
export const TIMELINE_EVENT_TYPES = [
  'EXAM_STARTED',
  'SESSION_TAKEOVER',
  'QUESTION_VIEWED',
  'PASTE_ATTEMPT',
  'COPY_ATTEMPT',
  'CUT_ATTEMPT',
  'DROP_ATTEMPT',
  'CONTEXT_MENU',
  'SUSPICIOUS_BULK_INSERT',
  'TAB_HIDDEN',
  'TAB_VISIBLE',
  'WINDOW_BLUR',
  'WINDOW_FOCUS',
  'PAGE_UNLOAD',
  'NETWORK_OFFLINE',
  'NETWORK_ONLINE',
  'IP_CHANGED',
  'EXAM_SUBMITTED',
  'EXAM_AUTO_SUBMITTED',
] as const;
const TIMELINE_SET = new Set<string>(TIMELINE_EVENT_TYPES);

/** No row, or a row only ever locked (never saved), is still PENDING. */
export function evaluationState(e: SubmissionSource['evaluation']): EvaluationState {
  if (!e) return 'PENDING';
  if (e.status === 'SUBMITTED') return 'SUBMITTED';
  return e.evaluatorId ? 'DRAFT' : 'PENDING';
}

export function toCandidatePii(c: Omit<CandidateSource, 'jobRole' | 'drive'>): CandidatePiiDto {
  return {
    candidateId: c.id,
    fullName: c.fullName,
    // Masked like everywhere else; HR reveals the full value on the candidate page.
    email: maskEmail(c.email),
    rollNumber: c.rollNumber,
    majorCpi: num(c.majorCpi),
    xPercentage: num(c.xPercentage),
    xiiPercentage: num(c.xiiPercentage),
    programme: c.programme,
    discipline: c.discipline,
  };
}

const CONCERNS = new Set<string>(AI_CONCERNS);
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The AI score shown for a question: the latest DONE one, else the latest of any status. */
export function pickAiScore(scores: AiScoreSource[]): AiScoreSource | null {
  return scores.find((s) => s.status === 'DONE') ?? scores[0] ?? null;
}

export function toAiScoreDto(s: AiScoreSource | null): AiQuestionScoreDto | null {
  if (!s) return null;
  return {
    id: s.id,
    status: s.status,
    marks: s.status === 'DONE' ? num(s.marks) : null,
    maxMarks: num(s.maxMarks) ?? 0,
    rationale: s.rationale,
    strengths: stringList(s.strengths),
    improvements: stringList(s.improvements),
    confidence: s.confidence,
    concerns: s.concerns.filter((c): c is AiConcern => CONCERNS.has(c)),
    model: s.model,
    error: s.error,
    completedAt: s.completedAt?.toISOString() ?? null,
  };
}

/** NONE = never run; DONE = every question has a DONE score; otherwise PARTIAL. */
export function toAiSummary(all: AiRollupQuestion[]): AiAttemptSummaryDto {
  const questions = all.filter((q) => q.typeSnapshot !== 'MCQ');
  if (!questions.some((q) => q.aiScores.length > 0)) return { state: 'NONE', totalMarks: null, percentage: null, needsReview: false };
  const picks = questions.map((q) => pickAiScore(q.aiScores));
  const done = picks.filter((p): p is AiScoreSource => p?.status === 'DONE');
  const needsReview = done.some((p) => p.concerns.length > 0 || p.confidence === 'LOW');
  if (done.length !== questions.length) return { state: 'PARTIAL', totalMarks: null, percentage: null, needsReview };
  const total = done.reduce((a, p) => a + (num(p.marks) ?? 0), 0);
  const max = questions.reduce((a, q) => a + (num(q.maxMarksSnapshot) ?? 0), 0);
  return { state: 'DONE', totalMarks: total, percentage: percentageOf(total, max), needsReview };
}

const finiteOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function toSubmissionView(row: SubmissionSource, viewerRole: AdminRole): SubmissionViewDto {
  const base: SubmissionViewDto = {
    attemptId: row.attemptId,
    candidateCode: row.candidate.candidateCode,
    jobRole: row.candidate.jobRole.name,
    jobProfileType: row.candidate.jobRole.type,
    roundNumber: row.candidate.drive.round.roundNumber,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    timeTakenSec: row.submittedAt ? Math.max(0, Math.round((row.submittedAt.getTime() - row.startedAt.getTime()) / 1000)) : null,
    submitType: row.submitType,
    mcqMarks: num(row.mcqMarks ?? null),
    mcqMaxMarks: num(row.mcqMaxMarks ?? null) ?? 0,
    flagCounts: Object.fromEntries(Object.entries(row.flags).map(([k, v]) => [k, finiteOr0(v)])),
    nearbyCount: row.nearbyCount ?? null,
    evaluationStatus: evaluationState(row.evaluation),
    totalMarks: num(row.totalMarks),
    ai: toAiSummary(row.questions),
  };
  if (viewerRole !== 'SUPER_ADMIN') return base;
  const c = row.candidate;
  return {
    ...base,
    ...toCandidatePii(c),
    driveDisplayName: driveDisplayName({ jobRoleName: c.jobRole.name, roundNumber: c.drive.round.roundNumber, collegeShortCode: c.drive.college.shortCode, batch: c.drive.batch }),
  };
}

function toMarkingQuestion(q: MarkingQuestionSource, activity: ActivitySource[]): MarkingQuestionDto {
  const mine = activity.filter((a) => a.questionId === q.id);
  const mcq = q.typeSnapshot === 'MCQ';
  return {
    attemptQuestionId: q.id,
    order: q.order,
    type: mcq ? 'MCQ' : 'WRITTEN',
    text: q.textSnapshot,
    // MCQ: read-only for the evaluator (auto-marked at submit).
    options: mcq ? [...(q.optionsSnapshot ?? [])] : [],
    selectedOption: mcq ? (q.answer?.selectedOption ?? null) : null,
    correctOption: mcq ? (q.correctSnapshot ?? null) : null,
    autoMarks: mcq ? num(q.autoMarks ?? null) : null,
    maxMarks: num(q.maxMarksSnapshot) ?? 0,
    evaluatorGuidance: q.question.evaluatorGuidance,
    answer: {
      text: q.answer?.text ?? '',
      wordCount: q.answer?.wordCount ?? 0,
      versions: (q.answer?.versions ?? []).map((v) => ({ savedAt: v.savedAt.toISOString(), wordCount: v.wordCount })),
    },
    integrity: {
      pasteAttempts: mine.filter((a) => PASTE_EVENTS.has(a.eventType)).length,
      bulkInsert: mine
        .filter((a) => a.eventType === 'SUSPICIOUS_BULK_INSERT')
        .map((a) => {
          const m = (a.metadata ?? {}) as { grown?: unknown; typed?: unknown };
          return { at: a.createdAt.toISOString(), grown: finiteOr0(m.grown), typed: finiteOr0(m.typed) };
        }),
    },
    evaluation: { marks: num(q.evaluation?.marks ?? null), comment: q.evaluation?.comment ?? null },
    ai: toAiScoreDto(pickAiScore(q.aiScores)),
    acceptedFromAi: (q.evaluation?.aiScoreId ?? null) !== null && q.evaluation?.marks !== null,
  };
}

export function toTimeline(activity: ActivitySource[], questions: MarkingQuestionSource[]): TimelineEventDto[] {
  const orderOf = new Map(questions.map((q) => [q.id, q.order]));
  return activity
    .filter((a) => TIMELINE_SET.has(a.eventType))
    .map((a) => {
      let bulk: TimelineEventDto['bulk'] = null;
      if (a.eventType === 'SUSPICIOUS_BULK_INSERT') {
        const m = (a.metadata ?? {}) as { grown?: unknown; typed?: unknown };
        bulk = { grown: finiteOr0(m.grown), typed: finiteOr0(m.typed) };
      }
      return {
        at: a.createdAt.toISOString(),
        type: a.eventType,
        questionOrder: a.questionId ? (orderOf.get(a.questionId) ?? null) : null,
        bulk,
      };
    });
}

export function toMarkingView(attempt: MarkingSource, viewerRole: AdminRole): MarkingViewDto {
  return {
    ...toSubmissionView(attempt, viewerRole),
    startedAt: attempt.startedAt.toISOString(),
    questions: [...attempt.questions].sort((a, b) => a.order - b.order).map((q) => toMarkingQuestion(q, attempt.activity)),
    timeline: toTimeline(attempt.activity, attempt.questions),
  };
}
