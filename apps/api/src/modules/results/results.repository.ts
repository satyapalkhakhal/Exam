// modules/results/results.repository.ts
// Prisma reads for the leaderboard, dashboard and exports, and the decision
// write (status + history + audit in one transaction, guarded so a decision can
// only follow an evaluation).

import { prisma } from '../../infrastructure/db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { writeAudit, type AuditRecord } from '../audit/index.js';

const SUBMITTED_STATUSES = ['SUBMITTED', 'AUTO_SUBMITTED'] as const;
export const DECIDABLE_STATUSES = ['EVALUATED', 'SHORTLISTED', 'REJECTED'] as const;
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
    select: { order: true, maxMarksSnapshot: true, evaluation: { select: { marks: true, comment: true } } },
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
    const rows = await prisma.candidate.groupBy({ by: ['jobRoleId', 'status'], _count: { _all: true } });
    return rows.map((r) => ({ jobRoleId: r.jobRoleId, status: r.status as CandidateStatusValue, count: r._count._all }));
  },

  /** Evaluated candidates of a role, best first, ties by earlier submit. */
  leaderboard(jobRoleId: string) {
    return prisma.examAttempt.findMany({
      where: {
        status: { in: [...SUBMITTED_STATUSES] },
        evaluation: { is: { status: 'SUBMITTED' } },
        totalMarks: { not: null },
        candidate: { jobRoleId, status: { in: [...DECIDABLE_STATUSES] } },
      },
      orderBy: rankOrder,
      select: scoredAttemptSelect,
    });
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
   * Sets the decision when the candidate is in a decidable status and not
   * already at it. Returns the previous status, or why it was refused.
   */
  decide(candidateId: string, decision: 'SHORTLISTED' | 'REJECTED', byAdminId: string, comment: string | null, audit: (from: CandidateStatusValue) => AuditRecord) {
    return prisma.$transaction(async (tx) => {
      const c = await tx.candidate.findUnique({ where: { id: candidateId }, select: { status: true } });
      if (!c) return { refused: 'NOT_FOUND' as const };
      const from = c.status as CandidateStatusValue;
      if (!(DECIDABLE_STATUSES as readonly string[]).includes(from) || from === decision) return { refused: 'STATUS' as const, from };
      const { count } = await tx.candidate.updateMany({ where: { id: candidateId, status: c.status }, data: { status: decision } });
      if (count !== 1) return { refused: 'STATUS' as const, from };
      await tx.candidateStatusHistory.create({ data: { candidateId, fromStatus: from, toStatus: decision, byAdminId, comment } });
      await writeAudit(tx, audit(from));
      return { from };
    });
  },
};

export type ResultsRepository = typeof resultsRepository;
export type ScoredAttempt = Awaited<ReturnType<ResultsRepository['leaderboard']>>[number];
export type LiveAttemptRow = Awaited<ReturnType<ResultsRepository['liveAttempts']>>[number];
