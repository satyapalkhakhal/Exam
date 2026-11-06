// modules/evaluation/evaluation.repository.ts
// Prisma access for marking. Only submitted attempts (SUBMITTED or
// AUTO_SUBMITTED; never IN_PROGRESS or RESET) are visible here. The soft lock
// is taken with one conditional UPDATE, so two evaluators racing for the same
// script cannot both win. Draft/submit/reopen run inside `transaction`; its
// first write (touchLock / reopen's status flip) takes the evaluation row lock,
// which serialises concurrent saves on one attempt. The candidate status change
// then takes the candidate row FOR UPDATE and re-reads the status there (the
// order is always evaluation row, then candidate row), so a decision or an
// attempt reset racing a submit/reopen is either seen or waits; history never
// records a stale "from".

import { prisma } from '../../infrastructure/db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { CandidateResult, SubmissionListQuery } from '@exam/shared';
import { writeAudit, type AuditRecord } from '../audit/index.js';
import { TIMELINE_EVENT_TYPES } from './evaluation.mapper.js';

type Tx = Prisma.TransactionClient;
export type CandidateStatusValue = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | 'EVALUATED' | 'SHORTLISTED' | 'REJECTED';

const SUBMITTED_STATUSES = ['SUBMITTED', 'AUTO_SUBMITTED'] as const;
// Everything the marking screen's timeline may show (and the per-question paste/bulk counts).
const TIMELINE_EVENTS = [...TIMELINE_EVENT_TYPES];
// A hard cap so a pathological attempt cannot blow up the marking payload.
const TIMELINE_MAX = 3000;

const candidateSelect = {
  id: true,
  candidateCode: true,
  fullName: true,
  email: true,
  rollNumber: true,
  xPercentage: true,
  xiiPercentage: true,
  majorCpi: true,
  programme: true,
  discipline: true,
  jobRole: { select: { name: true } },
} as const;

// Newest first; the mapper shows the latest DONE one, else the latest of any status.
const aiScoreSelect = {
  id: true,
  status: true,
  marks: true,
  maxMarks: true,
  rationale: true,
  strengths: true,
  improvements: true,
  confidence: true,
  concerns: true,
  model: true,
  error: true,
  completedAt: true,
} as const;
const aiScoresSelect = {
  orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] as Prisma.AiQuestionScoreOrderByWithRelationInput[],
  select: aiScoreSelect,
};

const submissionSelect = {
  id: true,
  startedAt: true,
  submittedAt: true,
  submitType: true,
  totalMarks: true,
  candidate: { select: candidateSelect },
  evaluation: { select: { status: true, evaluatorId: true } },
  questions: { select: { maxMarksSnapshot: true, aiScores: aiScoresSelect } },
} as const;

export interface LockHolder {
  id: string;
  name: string;
}

function evaluationFilter(state: SubmissionListQuery['evaluation']): Prisma.ExamAttemptWhereInput {
  switch (state) {
    case 'PENDING':
      return { OR: [{ evaluation: { is: null } }, { evaluation: { is: { status: 'DRAFT', evaluatorId: null } } }] };
    case 'DRAFT':
      return { evaluation: { is: { status: 'DRAFT', evaluatorId: { not: null } } } };
    case 'SUBMITTED':
      return { evaluation: { is: { status: 'SUBMITTED' } } };
    default:
      return {};
  }
}

// AI roll-up filter. NEEDS_REVIEW approximates "latest DONE has concerns" by
// "some DONE score has concerns or LOW confidence" (identical until a re-run).
const everyQuestionDone: Prisma.ExamAttemptWhereInput = {
  AND: [{ questions: { some: {} } }, { questions: { every: { aiScores: { some: { status: 'DONE' } } } } }],
};
function aiFilter(state: SubmissionListQuery['ai']): Prisma.ExamAttemptWhereInput {
  switch (state) {
    case 'NONE':
      return { questions: { every: { aiScores: { none: {} } } } };
    case 'PARTIAL':
      return { AND: [{ questions: { some: { aiScores: { some: {} } } } }, { questions: { some: { aiScores: { none: { status: 'DONE' } } } } }] };
    case 'DONE':
      return everyQuestionDone;
    case 'NEEDS_REVIEW':
      return {
        AND: [
          everyQuestionDone,
          { questions: { some: { aiScores: { some: { status: 'DONE', OR: [{ confidence: 'LOW' }, { concerns: { isEmpty: false } }] } } } } },
        ],
      };
    default:
      return {};
  }
}

async function liveHolder(db: Tx, attemptId: string, cutoff: Date): Promise<LockHolder | null> {
  const row = await db.attemptEvaluation.findUnique({
    where: { attemptId },
    select: { lockedAt: true, lockedBy: { select: { id: true, name: true } } },
  });
  if (!row?.lockedBy || !row.lockedAt || row.lockedAt < cutoff) return null;
  return row.lockedBy;
}

function txMethods(tx: Tx) {
  return {
    /** Refreshes the caller's live lock on a DRAFT evaluation; false when not held or already submitted. */
    async touchLock(attemptId: string, adminId: string, now: Date, cutoff: Date): Promise<boolean> {
      const { count } = await tx.attemptEvaluation.updateMany({
        where: { attemptId, status: 'DRAFT', lockedById: adminId, lockedAt: { gte: cutoff } },
        data: { lockedAt: now },
      });
      return count === 1;
    },
    evaluationStatus(attemptId: string) {
      return tx.attemptEvaluation.findUnique({ where: { attemptId }, select: { status: true } });
    },
    liveHolder: (attemptId: string, cutoff: Date) => liveHolder(tx, attemptId, cutoff),
    attempt(attemptId: string) {
      return tx.examAttempt.findFirst({
        where: { id: attemptId, status: { in: [...SUBMITTED_STATUSES] } },
        select: { id: true, status: true, candidateId: true, candidate: { select: { status: true } } },
      });
    },
    questions(attemptId: string) {
      return tx.attemptQuestion.findMany({ where: { attemptId }, select: { id: true, order: true, maxMarksSnapshot: true } });
    },
    /**
     * Writes one question's draft. `comment` undefined keeps the stored one.
     * A row left with neither marks nor a comment is removed.
     */
    async setMark(attemptQuestionId: string, marks: number | null, comment: string | null | undefined, evaluatorId: string): Promise<void> {
      // AI provenance survives only while the stored mark is left unchanged.
      const prev = await tx.questionEvaluation.findUnique({ where: { attemptQuestionId }, select: { marks: true, aiScoreId: true } });
      const changed = prev?.aiScoreId != null && (marks === null || prev.marks === null || prev.marks.toNumber() !== marks);
      await tx.questionEvaluation.upsert({
        where: { attemptQuestionId },
        create: { attemptQuestionId, marks, comment: comment ?? null, evaluatorId },
        update: { marks, evaluatorId, ...(comment !== undefined ? { comment } : {}), ...(changed ? { aiScoreId: null } : {}) },
      });
      if (marks === null) await tx.questionEvaluation.deleteMany({ where: { attemptQuestionId, marks: null, comment: null } });
    },
    marks(attemptId: string) {
      return tx.questionEvaluation.findMany({
        where: { attemptQuestion: { attemptId }, marks: { not: null } },
        select: { attemptQuestionId: true, marks: true },
      });
    },
    async markDraft(attemptId: string, evaluatorId: string): Promise<void> {
      await tx.attemptEvaluation.update({ where: { attemptId }, data: { evaluatorId } });
    },
    async complete(attemptId: string, evaluatorId: string, at: Date, totals: { totalMarks: number; maxMarks: number; percentage: number }): Promise<void> {
      await tx.attemptEvaluation.update({
        where: { attemptId },
        data: { status: 'SUBMITTED', evaluatorId, submittedAt: at, lockedById: null, lockedAt: null },
      });
      await tx.examAttempt.update({ where: { id: attemptId }, data: totals });
    },
    /** SUBMITTED → DRAFT; false when it was not submitted (lost a race). */
    async reopen(attemptId: string): Promise<boolean> {
      const { count } = await tx.attemptEvaluation.updateMany({
        where: { attemptId, status: 'SUBMITTED' },
        data: { status: 'DRAFT', submittedAt: null, lockedById: null, lockedAt: null },
      });
      if (count === 1) await tx.examAttempt.update({ where: { id: attemptId }, data: { totalMarks: null, percentage: null } });
      return count === 1;
    },
    /**
     * Moves the candidate to `to` under the candidate row lock, with the status
     * read under that lock as `from`. null when the attempt was reset meanwhile
     * (the candidate has moved on to a new attempt and must not be touched).
     */
    async transitionCandidate(
      candidateId: string,
      attemptId: string,
      to: CandidateStatusValue,
      byAdminId: string,
      comment: string | null,
      opts: { clearResult?: boolean } = {},
    ): Promise<{ from: CandidateStatusValue; fromResult: CandidateResult | null } | null> {
      const rows = await tx.$queryRaw<{ status: CandidateStatusValue; result: CandidateResult | null }[]>`
        SELECT status::text AS status, result::text AS result FROM candidates WHERE id = ${candidateId}::uuid FOR UPDATE`;
      const from = rows[0]?.status;
      if (!from) return null;
      const fromResult = rows[0]!.result;
      const live = await tx.examAttempt.count({ where: { id: attemptId, status: { in: [...SUBMITTED_STATUSES] } } });
      if (live === 0) return null;
      const clear = opts.clearResult === true;
      await tx.candidate.update({ where: { id: candidateId }, data: clear ? { status: to, result: null, resultAt: null, resultById: null } : { status: to } });
      await tx.candidateStatusHistory.create({
        data: { candidateId, fromStatus: from, toStatus: to, fromResult, toResult: clear ? null : fromResult, byAdminId, comment },
      });
      return { from, fromResult };
    },
    /** Bulk accept: the attempt in any status, so the skip reason can be told apart. */
    attemptAny(attemptId: string) {
      return tx.examAttempt.findUnique({
        where: { id: attemptId },
        select: { id: true, status: true, candidateId: true, candidate: { select: { candidateCode: true } } },
      });
    },
    /** Creates the evaluation row if missing and locks it FOR UPDATE; the lock holder is read under that lock. */
    async lockEvaluationRow(attemptId: string): Promise<{ status: 'DRAFT' | 'SUBMITTED'; lockedById: string | null; lockedAt: Date | null }> {
      await tx.attemptEvaluation.createMany({ data: [{ attemptId }], skipDuplicates: true });
      const rows = await tx.$queryRaw<{ status: 'DRAFT' | 'SUBMITTED'; locked_by_id: string | null; locked_at: Date | null }[]>`
        SELECT status::text AS status, locked_by_id::text AS locked_by_id, locked_at FROM attempt_evaluations WHERE attempt_id = ${attemptId}::uuid FOR UPDATE`;
      const r = rows[0]!;
      return { status: r.status, lockedById: r.locked_by_id, lockedAt: r.locked_at };
    },
    /** Every question of the attempt with its latest DONE AI score (if any). */
    async questionsWithAi(attemptId: string) {
      const rows = await tx.attemptQuestion.findMany({
        where: { attemptId },
        orderBy: { order: 'asc' },
        select: {
          id: true,
          maxMarksSnapshot: true,
          aiScores: { where: { status: 'DONE' }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 1, select: { id: true, marks: true, confidence: true, concerns: true } },
        },
      });
      return rows.map((q) => ({
        id: q.id,
        maxMarks: q.maxMarksSnapshot.toNumber(),
        ai: q.aiScores[0] ? { id: q.aiScores[0].id, marks: q.aiScores[0].marks?.toNumber() ?? null, confidence: q.aiScores[0].confidence, concerns: q.aiScores[0].concerns } : null,
      }));
    },
    /** Writes the AI mark as the actor's mark, with provenance. The comment is left alone. */
    async setMarkFromAi(attemptQuestionId: string, marks: number, aiScoreId: string, evaluatorId: string): Promise<void> {
      await tx.questionEvaluation.upsert({
        where: { attemptQuestionId },
        create: { attemptQuestionId, marks, evaluatorId, aiScoreId },
        update: { marks, evaluatorId, aiScoreId },
      });
    },
    audit: (entry: AuditRecord) => writeAudit(tx, entry),
  };
}

export type EvaluationTx = ReturnType<typeof txMethods>;

export const evaluationRepository = {
  transaction<T>(fn: (r: EvaluationTx) => Promise<T>): Promise<T> {
    return prisma.$transaction((tx) => fn(txMethods(tx)), { timeout: 15_000 });
  },

  async listSubmissions(q: SubmissionListQuery, searchNames: boolean) {
    const and: Prisma.ExamAttemptWhereInput[] = [{ status: { in: [...SUBMITTED_STATUSES] } }, evaluationFilter(q.evaluation), aiFilter(q.ai)];
    if (q.jobRoleId) and.push({ candidate: { jobRoleId: q.jobRoleId } });
    if (q.search) {
      const or: Prisma.CandidateWhereInput[] = [{ candidateCode: { contains: q.search, mode: 'insensitive' } }];
      // Identity fields only for a Super Admin; an Evaluator searches by code alone (blind marking).
      if (searchNames) {
        or.push(
          { fullName: { contains: q.search, mode: 'insensitive' } },
          { rollNumber: { contains: q.search, mode: 'insensitive' } },
          { email: { contains: q.search, mode: 'insensitive' } },
        );
      }
      and.push({ candidate: { OR: or } });
    }
    const where: Prisma.ExamAttemptWhereInput = { AND: and };
    const [rows, total] = await prisma.$transaction([
      prisma.examAttempt.findMany({
        where,
        select: submissionSelect,
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.examAttempt.count({ where }),
    ]);
    return { rows, total };
  },

  async marking(attemptId: string) {
    const attempt = await prisma.examAttempt.findFirst({
      where: { id: attemptId, status: { in: [...SUBMITTED_STATUSES] } },
      select: {
        ...submissionSelect,
        questions: {
          orderBy: { order: 'asc' },
          select: {
            id: true,
            order: true,
            textSnapshot: true,
            maxMarksSnapshot: true,
            question: { select: { evaluatorGuidance: true } },
            answer: {
              select: { text: true, wordCount: true, versions: { orderBy: { savedAt: 'asc' }, select: { savedAt: true, wordCount: true } } },
            },
            evaluation: { select: { marks: true, comment: true, aiScoreId: true } },
            aiScores: aiScoresSelect,
          },
        },
      },
    });
    if (!attempt) return null;
    const activity = await prisma.activityLog.findMany({
      where: { attemptId, eventType: { in: TIMELINE_EVENTS } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: TIMELINE_MAX,
      select: { eventType: true, questionId: true, createdAt: true, metadata: true },
    });
    return { ...attempt, activity };
  },

  /** Submitted attempts of a role whose evaluation is not yet submitted (bulk accept by role). */
  async openAttemptIdsForRole(jobRoleId: string): Promise<string[]> {
    const rows = await prisma.examAttempt.findMany({
      where: { status: { in: [...SUBMITTED_STATUSES] }, candidate: { jobRoleId }, NOT: { evaluation: { is: { status: 'SUBMITTED' } } } },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return rows.map((r) => r.id);
  },

  async candidateIdsOf(attemptIds: string[]): Promise<Map<string, string>> {
    const rows = await prisma.examAttempt.findMany({ where: { id: { in: attemptIds } }, select: { id: true, candidateId: true } });
    return new Map(rows.map((r) => [r.id, r.candidateId]));
  },

  recordAudit: (entry: AuditRecord) => writeAudit(prisma, entry),

  async submittedAttemptExists(attemptId: string): Promise<boolean> {
    return (await prisma.examAttempt.count({ where: { id: attemptId, status: { in: [...SUBMITTED_STATUSES] } } })) > 0;
  },

  /**
   * Takes or refreshes the lock on a DRAFT evaluation unless someone else holds
   * a live one. A submitted evaluation is never locked (it is read-only until a
   * Super Admin reopens it).
   */
  async acquireLock(
    attemptId: string,
    adminId: string,
    now: Date,
    cutoff: Date,
  ): Promise<{ result: 'LOCKED'; holder: LockHolder; lockedAt: Date } | { result: 'HELD'; holder: LockHolder | null } | { result: 'SUBMITTED' }> {
    await prisma.attemptEvaluation.createMany({ data: [{ attemptId }], skipDuplicates: true });
    const { count } = await prisma.attemptEvaluation.updateMany({
      where: {
        attemptId,
        status: 'DRAFT',
        OR: [{ lockedById: null }, { lockedAt: null }, { lockedById: adminId }, { lockedAt: { lt: cutoff } }],
      },
      data: { lockedById: adminId, lockedAt: now },
    });
    if (count === 1) {
      const me = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId }, select: { id: true, name: true } });
      return { result: 'LOCKED', holder: me, lockedAt: now };
    }
    const row = await prisma.attemptEvaluation.findUnique({ where: { attemptId }, select: { status: true } });
    if (row?.status === 'SUBMITTED') return { result: 'SUBMITTED' };
    return { result: 'HELD', holder: await liveHolder(prisma, attemptId, cutoff) };
  },

  async releaseLock(attemptId: string, adminId: string): Promise<void> {
    await prisma.attemptEvaluation.updateMany({ where: { attemptId, lockedById: adminId }, data: { lockedById: null, lockedAt: null } });
  },
};

export type EvaluationRepository = typeof evaluationRepository;
