// modules/results/results.repository.ts
// Prisma reads for the leaderboard, dashboard and exports, and the decision
// write (result + history + audit in one transaction, guarded so a decision can
// only follow an evaluation). The decision lives in candidates.result; the
// status keeps exam progress.

import { prisma } from '../../infrastructure/db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { CandidateDecisionBulkResultDto, CandidateResult } from '@exam/shared';
import { writeAudit, type AuditRecord } from '../audit/index.js';

const SUBMITTED_STATUSES = ['SUBMITTED', 'AUTO_SUBMITTED'] as const;
export type CandidateStatusValue = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | 'EVALUATED' | 'SHORTLISTED' | 'REJECTED';

const candidateSelect = {
  id: true,
  candidateCode: true,
  fullName: true,
  email: true,
  mobile: true,
  rollNumber: true,
  xPercentage: true,
  xiiPercentage: true,
  majorCpi: true,
  programme: true,
  discipline: true,
  status: true,
  result: true,
  jobRoleId: true,
  jobRole: { select: { name: true } },
} as const;

const scoredAttemptSelect = {
  id: true,
  status: true,
  startedAt: true,
  submittedAt: true,
  submitType: true,
  totalMarks: true,
  maxMarks: true,
  percentage: true,
  candidate: { select: candidateSelect },
  evaluation: { select: { status: true } },
  questions: {
    orderBy: { order: 'asc' },
    select: {
      order: true,
      maxMarksSnapshot: true,
      evaluation: { select: { marks: true, comment: true } },
      // Latest DONE AI score only.
      aiScores: { where: { status: 'DONE' }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 1, select: { marks: true } },
    },
  },
} as const satisfies Prisma.ExamAttemptSelect;

const rankOrder: Prisma.ExamAttemptOrderByWithRelationInput[] = [
  { totalMarks: { sort: 'desc', nulls: 'last' } },
  { submittedAt: 'asc' },
  { id: 'asc' },
];

export const resultsRepository = {
  roles(jobRoleId?: string) {
    return prisma.jobRole.findMany({
      where: jobRoleId ? { id: jobRoleId } : {},
      orderBy: { name: 'asc' },
      select: { id: true, name: true, refApplicantCount: true },
    });
  },

  async statusCounts() {
    const rows = await prisma.candidate.groupBy({ by: ['jobRoleId', 'status', 'result'], _count: { _all: true } });
    return rows.map((r) => ({ jobRoleId: r.jobRoleId, status: r.status as CandidateStatusValue, result: r.result, count: r._count._all }));
  },

  /**
   * Evaluated candidates of a role, best first, ties by earlier submit. With
   * `withAiOnly`, also submitted attempts that are not human-evaluated yet but
   * have an AI score (they appear with a provisional composite).
   */
  leaderboard(jobRoleId: string, withAiOnly = false) {
    const evaluated: Prisma.ExamAttemptWhereInput = {
      evaluation: { is: { status: 'SUBMITTED' } },
      totalMarks: { not: null },
      candidate: { jobRoleId, status: 'EVALUATED' },
    };
    const aiOnly: Prisma.ExamAttemptWhereInput = {
      NOT: { evaluation: { is: { status: 'SUBMITTED' } } },
      candidate: { jobRoleId },
      questions: { some: { aiScores: { some: { status: 'DONE' } } } },
    };
    return prisma.examAttempt.findMany({
      where: { status: { in: [...SUBMITTED_STATUSES] }, ...(withAiOnly ? { OR: [evaluated, aiOnly] } : evaluated) },
      orderBy: rankOrder,
      select: scoredAttemptSelect,
    });
  },

  /** Composite weights per role (a role without a settings row uses the defaults in the service). */
  async weightsFor(jobRoleIds: string[]): Promise<Map<string, { exam: number; x: number; xii: number; cpi: number }>> {
    const rows = await prisma.examSetting.findMany({
      where: { jobRoleId: { in: jobRoleIds } },
      select: { jobRoleId: true, weightExam: true, weightX: true, weightXii: true, weightCpi: true },
    });
    return new Map(rows.map((r) => [r.jobRoleId, { exam: r.weightExam, x: r.weightX, xii: r.weightXii, cpi: r.weightCpi }]));
  },

  /** Every submitted attempt of the roles, ranked like the leaderboard (unevaluated last). */
  submittedAttempts(jobRoleIds: string[]) {
    return prisma.examAttempt.findMany({
      where: { status: { in: [...SUBMITTED_STATUSES] }, candidate: { jobRoleId: { in: jobRoleIds } } },
      orderBy: rankOrder,
      select: scoredAttemptSelect,
    });
  },

  /** Every live (not reset) attempt of the roles, for the integrity export. */
  liveAttempts(jobRoleIds: string[]) {
    return prisma.examAttempt.findMany({
      where: { status: { not: 'RESET' }, candidate: { jobRoleId: { in: jobRoleIds } } },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, status: true, startedAt: true, submittedAt: true, candidate: { select: candidateSelect } },
    });
  },

  async codesFor(candidateIds: string[]): Promise<Map<string, string>> {
    if (candidateIds.length === 0) return new Map();
    const rows = await prisma.candidate.findMany({ where: { id: { in: candidateIds } }, select: { id: true, candidateCode: true } });
    return new Map(rows.map((r) => [r.id, r.candidateCode]));
  },

  /**
   * Sets the result on every EVALUATED candidate whose result differs, in one
   * transaction with the rows locked in id order (as other bulk writes do). One
   * history row (status unchanged, result from/to) and one audit row each.
   */
  decideMany(
    ids: string[],
    decision: CandidateResult,
    byAdminId: string,
    comment: string | null,
    audit: (candidateId: string, from: CandidateResult | null) => AuditRecord,
  ): Promise<{ decided: string[]; skipped: CandidateDecisionBulkResultDto['skipped'] }> {
    return prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; status: CandidateStatusValue; result: CandidateResult | null; candidate_code: string; full_name: string }[]>`
          SELECT id::text, status::text AS status, result::text AS result, candidate_code, full_name
          FROM candidates WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
        const byId = new Map(rows.map((r) => [r.id, r]));
        const decided: string[] = [];
        const skipped: CandidateDecisionBulkResultDto['skipped'] = [];
        const now = new Date();
        for (const id of ids) {
          const c = byId.get(id);
          if (!c) {
            skipped.push({ candidateId: id, candidateCode: null, fullName: null, reason: 'NOT_FOUND' });
            continue;
          }
          const reason = c.status !== 'EVALUATED' ? 'NOT_EVALUATED' : c.result === decision ? 'ALREADY_DECIDED' : null;
          if (reason) {
            skipped.push({ candidateId: id, candidateCode: c.candidate_code, fullName: c.full_name, reason });
            continue;
          }
          await tx.candidate.update({ where: { id }, data: { result: decision, resultAt: now, resultById: byAdminId } });
          await tx.candidateStatusHistory.create({
            data: { candidateId: id, fromStatus: c.status, toStatus: c.status, fromResult: c.result, toResult: decision, byAdminId, comment },
          });
          await writeAudit(tx, audit(id, c.result));
          decided.push(id);
        }
        return { decided, skipped };
      },
      { timeout: 60_000 },
    );
  },
};

export type ResultsRepository = typeof resultsRepository;
export type ScoredAttempt = Awaited<ReturnType<ResultsRepository['leaderboard']>>[number];
export type LiveAttemptRow = Awaited<ReturnType<ResultsRepository['liveAttempts']>>[number];
