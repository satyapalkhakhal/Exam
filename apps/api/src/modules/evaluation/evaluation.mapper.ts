// modules/evaluation/evaluation.mapper.ts
// Blind marking, enforced here (design §8): every DTO is built field by field
// from a whitelist, never by spreading a row, so a new column on the candidate
// or a stray metadata key cannot reach the Evaluator. Identity and academics
// are added only for a Super Admin; location (coordinates, IPs) is never
// included for anyone. Integrity evidence is reduced to counts and the
// bulk-insert numbers, never the raw activity metadata. The exam timeline is the
// same idea: whitelisted event types with time and question only (an IP change
// shows that it happened, never the addresses).

import { maskEmail } from '../../shared/utils/piiMask.js';
import type {
  AdminRole,
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
  jobRole: { name: string };
}

export interface SubmissionSource {
  attemptId: string;
  startedAt: Date;
  submittedAt: Date | null;
  submitType: 'MANUAL' | 'AUTO' | null;
  totalMarks: Num;
  evaluation: { status: 'DRAFT' | 'SUBMITTED'; evaluatorId: string | null } | null;
  candidate: CandidateSource;
  flags: Record<string, number>;
  /** Omitted by older callers/tests: treated as no start location. */
  nearbyCount?: number | null;
}

export interface MarkingQuestionSource {
  id: string;
  order: number;
  textSnapshot: string;
  maxMarksSnapshot: Num;
  question: { evaluatorGuidance: string | null };
  answer: { text: string; wordCount: number; versions: { savedAt: Date; wordCount: number }[] } | null;
  evaluation: { marks: Num; comment: string | null } | null;
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

export function toCandidatePii(c: CandidateSource): CandidatePiiDto {
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

const finiteOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function toSubmissionView(row: SubmissionSource, viewerRole: AdminRole): SubmissionViewDto {
  const base: SubmissionViewDto = {
    attemptId: row.attemptId,
    candidateCode: row.candidate.candidateCode,
    jobRole: row.candidate.jobRole.name,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    timeTakenSec: row.submittedAt ? Math.max(0, Math.round((row.submittedAt.getTime() - row.startedAt.getTime()) / 1000)) : null,
    submitType: row.submitType,
    flagCounts: Object.fromEntries(Object.entries(row.flags).map(([k, v]) => [k, finiteOr0(v)])),
    nearbyCount: row.nearbyCount ?? null,
    evaluationStatus: evaluationState(row.evaluation),
    totalMarks: num(row.totalMarks),
  };
  return viewerRole === 'SUPER_ADMIN' ? { ...base, ...toCandidatePii(row.candidate) } : base;
}

function toMarkingQuestion(q: MarkingQuestionSource, activity: ActivitySource[]): MarkingQuestionDto {
  const mine = activity.filter((a) => a.questionId === q.id);
  return {
    attemptQuestionId: q.id,
    order: q.order,
    text: q.textSnapshot,
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
