// modules/results/results.repository.ts
// Prisma reads for the leaderboard, dashboard and exports, and the decision
// write (result + history + audit in one transaction, guarded so a decision can
// only follow an evaluation). The decision lives in candidates.result; the
// status keeps exam progress.

import { prisma } from '../../infrastructure/db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { driveDisplayName, type CandidateDecisionBulkResultDto, type CandidateResult, type CompositeWeights, type JobProfileType } from '@exam/shared';
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
  driveId: true,
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
  mcqMarks: true,
  mcqMaxMarks: true,
  candidate: { select: candidateSelect },
  evaluation: { select: { status: true } },
  questions: {
    orderBy: { order: 'asc' },
    select: {
      order: true,
      typeSnapshot: true,
      maxMarksSnapshot: true,
      // MCQ: the correct index (shown order) and the candidate's pick, for the export's counts.
      correctSnapshot: true,
      answer: { select: { selectedOption: true } },
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

/** A drive as results need it: names for sheets and the dashboard, its round's weights. */
export interface ResultDrive {
  id: string;
  jobRoleId: string;
  jobRoleName: string;
  jobProfileType: JobProfileType;
  roundId: string;
  roundNumber: number;
  collegeId: string;
  collegeName: string;
  collegeShortCode: string;
  batch: string;
  refApplicantCount: number;
  weights: CompositeWeights;
}

export const displayNameOf = (d: ResultDrive): string =>
  driveDisplayName({ jobRoleName: d.jobRoleName, roundNumber: d.roundNumber, collegeShortCode: d.collegeShortCode, batch: d.batch });

export interface DriveFilter {
  driveId?: string;
  roundId?: string;
  collegeId?: string;
  jobRoleId?: string;
}

export const resultsRepository = {
  /** Drives matching the filter (all when empty), ordered job profile, round, college, batch. */
  async drives(f: DriveFilter): Promise<ResultDrive[]> {
    const rows = await prisma.drive.findMany({
      where: {
        ...(f.driveId ? { id: f.driveId } : {}),
        ...(f.roundId ? { roundId: f.roundId } : {}),
        ...(f.collegeId ? { collegeId: f.collegeId } : {}),
        ...(f.jobRoleId ? { round: { jobRoleId: f.jobRoleId } } : {}),
      },
      orderBy: [{ round: { jobRole: { name: 'asc' } } }, { round: { roundNumber: 'asc' } }, { college: { shortCode: 'asc' } }, { batch: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        batch: true,
        college: { select: { id: true, name: true, shortCode: true } },
        round: {
          select: {
            id: true, roundNumber: true, jobRoleId: true, weightExam: true, weightX: true, weightXii: true, weightCpi: true,
            jobRole: { select: { name: true, type: true, refApplicantCount: true } },
          },
        },
      },
    });
    return rows.map((d) => ({
      id: d.id,
      jobRoleId: d.round.jobRoleId,
      jobRoleName: d.round.jobRole.name,
      jobProfileType: d.round.jobRole.type,
      roundId: d.round.id,
      roundNumber: d.round.roundNumber,
      collegeId: d.college.id,
      collegeName: d.college.name,
      collegeShortCode: d.college.shortCode,
      batch: d.batch,
      refApplicantCount: d.round.jobRole.refApplicantCount,
      weights: { exam: d.round.weightExam, x: d.round.weightX, xii: d.round.weightXii, cpi: d.round.weightCpi },
    }));
  },

  /**
   * Per drive: sum and count of evaluated exam % (evaluation submitted, live attempt only —
   * never a reset one), for the dashboard's averages weighted across drives.
   */
  async examPercentStats(): Promise<{ driveId: string; sum: number; count: number }[]> {
    const rows = await prisma.$queryRaw<{ drive_id: string; sum: Prisma.Decimal | null; count: bigint }[]>`
      SELECT c.drive_id::text AS drive_id, sum(a.percentage) AS sum, count(*) AS count
      FROM exam_attempts a
      JOIN candidates c ON c.id = a.candidate_id
      JOIN attempt_evaluations e ON e.attempt_id = a.id AND e.status = 'SUBMITTED'
      WHERE a.status IN ('SUBMITTED', 'AUTO_SUBMITTED') AND a.percentage IS NOT NULL
      GROUP BY c.drive_id`;
    return rows.map((r) => ({ driveId: r.drive_id, sum: Math.round(Number(r.sum ?? 0) * 100) / 100, count: Number(r.count) }));
  },

  async statusCounts() {
    const rows = await prisma.candidate.groupBy({ by: ['driveId', 'status', 'result'], _count: { _all: true } });
    return rows.map((r) => ({ driveId: r.driveId, status: r.status as CandidateStatusValue, result: r.result, count: r._count._all }));
  },

  /**
   * Evaluated candidates of a drive, best first, ties by earlier submit. With
   * `withAiOnly`, also submitted attempts that are not human-evaluated yet but
   * have an AI score (they appear with a provisional composite).
   */
  leaderboard(driveId: string, withAiOnly = false) {
    const evaluated: Prisma.ExamAttemptWhereInput = {
      evaluation: { is: { status: 'SUBMITTED' } },
      totalMarks: { not: null },
      candidate: { driveId, status: 'EVALUATED' },
    };
    const aiOnly: Prisma.ExamAttemptWhereInput = {
      NOT: { evaluation: { is: { status: 'SUBMITTED' } } },
      candidate: { driveId },
      questions: { some: { aiScores: { some: { status: 'DONE' } } } },
    };
    return prisma.examAttempt.findMany({
      where: { status: { in: [...SUBMITTED_STATUSES] }, ...(withAiOnly ? { OR: [evaluated, aiOnly] } : evaluated) },
      orderBy: rankOrder,
      select: scoredAttemptSelect,
    });
  },

  /** Every submitted attempt of the drives, ranked like the leaderboard (unevaluated last). */
  submittedAttempts(driveIds: string[]) {
    return prisma.examAttempt.findMany({
      where: { status: { in: [...SUBMITTED_STATUSES] }, candidate: { driveId: { in: driveIds } } },
      orderBy: rankOrder,
      select: scoredAttemptSelect,
    });
  },

  /** Every live (not reset) attempt of the drives, for the integrity export. */
  liveAttempts(driveIds: string[]) {
    return prisma.examAttempt.findMany({
      where: { status: { not: 'RESET' }, candidate: { driveId: { in: driveIds } } },
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
