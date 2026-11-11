// modules/drives/drives.repository.ts
// colleges, exam_rounds and drives access. Writes commit with their audit row.
// Case-insensitive uniqueness lives in raw expression indexes (migration
// 20261110090000); their violations arrive as P2002 like any unique index.

import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import { nextCandidateCodes } from '../candidates/candidateCode.js';
import { siblingEntry } from '../candidates/candidates.repository.js';
import type { PromoteResultDto } from '@exam/shared';
import type { CollegeRow, DriveRow, DrivesRepository, RoundRow } from './drives.service.js';

const isUnique = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

async function unique<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUnique(err)) throw conflict(message);
    throw err;
  }
}

const COLLEGE_TAKEN = 'A college with this name or short code already exists.';
const DRIVE_TAKEN = 'This round already has a drive at this college with the same batch.';

const collegeInclude = { _count: { select: { drives: true } } } as const;
type CollegeRecord = Prisma.CollegeGetPayload<{ include: typeof collegeInclude }>;
const toCollege = (c: CollegeRecord): CollegeRow => ({ id: c.id, name: c.name, shortCode: c.shortCode, active: c.active, driveCount: c._count.drives });

const roundInclude = { _count: { select: { questions: true } } } as const;
type RoundRecord = Prisma.ExamRoundGetPayload<{ include: typeof roundInclude }>;
export const toRoundRow = (r: RoundRecord): RoundRow => ({
  id: r.id,
  jobRoleId: r.jobRoleId,
  roundNumber: r.roundNumber,
  name: r.name,
  durationMinutes: r.durationMinutes,
  questionsLocked: r.questionsLocked,
  weightExam: r.weightExam,
  weightX: r.weightX,
  weightXii: r.weightXii,
  weightCpi: r.weightCpi,
  mcqNegativeMarks: Number(r.mcqNegativeMarks),
  questionCount: r._count.questions,
});

const driveInclude = {
  round: { select: { roundNumber: true, jobRoleId: true, jobRole: { select: { name: true, type: true } } } },
  college: { select: { id: true, name: true, shortCode: true } },
  _count: { select: { candidates: true } },
} as const;
type DriveRecord = Prisma.DriveGetPayload<{ include: typeof driveInclude }>;

const driveOrder: Prisma.DriveOrderByWithRelationInput[] = [
  { round: { jobRole: { name: 'asc' } } },
  { round: { roundNumber: 'asc' } },
  { college: { shortCode: 'asc' } },
  { batch: 'asc' },
  { id: 'asc' },
];

/** Candidates per drive who have started (any status but NOT_STARTED). */
async function startedCounts(driveIds: string[]): Promise<Map<string, number>> {
  if (driveIds.length === 0) return new Map();
  const rows = await prisma.candidate.groupBy({
    by: ['driveId'],
    where: { driveId: { in: driveIds }, status: { not: 'NOT_STARTED' } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.driveId, r._count._all]));
}

async function toDrives(records: DriveRecord[]): Promise<DriveRow[]> {
  const started = await startedCounts(records.map((d) => d.id));
  return records.map((d) => ({
    id: d.id,
    roundId: d.roundId,
    roundNumber: d.round.roundNumber,
    jobRoleId: d.round.jobRoleId,
    jobRoleName: d.round.jobRole.name,
    jobProfileType: d.round.jobRole.type,
    college: d.college,
    batch: d.batch,
    windowStart: d.windowStart,
    windowEnd: d.windowEnd,
    isOpen: d.isOpen,
    instructions: d.instructions,
    active: d.active,
    candidateCount: d._count.candidates,
    startedCount: started.get(d.id) ?? 0,
  }));
}

const one = async (record: DriveRecord | null): Promise<DriveRow | null> => (record ? (await toDrives([record]))[0]! : null);

export const drivesRepository: DrivesRepository = {
  async listColleges() {
    const rows = await prisma.college.findMany({ include: collegeInclude, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    return rows.map(toCollege);
  },

  async findCollege(id) {
    const row = await prisma.college.findUnique({ where: { id }, include: collegeInclude });
    return row ? toCollege(row) : null;
  },

  createCollege(data, audit) {
    return unique(
      () =>
        prisma.$transaction(async (tx) => {
          const row = await tx.college.create({ data, include: collegeInclude });
          await writeAudit(tx, audit(row.id));
          return toCollege(row);
        }),
      COLLEGE_TAKEN,
    );
  },

  updateCollege(id, data, audit) {
    return unique(
      () =>
        prisma.$transaction(async (tx) => {
          const row = await tx.college.update({ where: { id }, data, include: collegeInclude });
          await writeAudit(tx, audit);
          return toCollege(row);
        }),
      COLLEGE_TAKEN,
    );
  },

  async roleExists(jobRoleId) {
    return (await prisma.jobRole.count({ where: { id: jobRoleId } })) > 0;
  },

  addRound(jobRoleId, name, audit) {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM job_roles WHERE id = ${jobRoleId}::uuid FOR UPDATE`;
      const max = await tx.examRound.aggregate({ where: { jobRoleId }, _max: { roundNumber: true } });
      const roundNumber = (max._max.roundNumber ?? 0) + 1;
      const row = await tx.examRound.create({ data: { jobRoleId, roundNumber, name }, include: roundInclude });
      await writeAudit(tx, audit(row.id, roundNumber));
      return toRoundRow(row);
    });
  },

  async findRound(id) {
    const row = await prisma.examRound.findUnique({ where: { id }, include: roundInclude });
    return row ? toRoundRow(row) : null;
  },

  updateRound(id, data, audit, guard) {
    const { weights, ...rest } = data;
    const w = weights ? { weightExam: weights.exam, weightX: weights.x, weightXii: weights.xii, weightCpi: weights.cpi } : {};
    return prisma.$transaction(async (tx) => {
      if (guard) {
        // FOR UPDATE waits for any start holding the row (FOR SHARE) and then reads its lock.
        const rows = await tx.$queryRaw<{ questions_locked: boolean; mcq_negative_marks: Prisma.Decimal }[]>`
          SELECT questions_locked, mcq_negative_marks FROM exam_rounds WHERE id = ${id}::uuid FOR UPDATE`;
        if (rows[0]) {
          const agg = await tx.question.aggregate({ where: { roundId: id, type: 'MCQ', active: true }, _min: { maxMarks: true } });
          guard({
            questionsLocked: rows[0].questions_locked,
            mcqNegativeMarks: Number(rows[0].mcq_negative_marks),
            minMcqMarks: agg._min.maxMarks === null ? null : Number(agg._min.maxMarks),
          });
        }
      }
      const row = await tx.examRound.update({ where: { id }, data: { ...rest, ...w }, include: roundInclude });
      await writeAudit(tx, audit);
      return toRoundRow(row);
    });
  },

  async listDrives(q) {
    const rows = await prisma.drive.findMany({
      where: {
        ...(q.roundId ? { roundId: q.roundId } : {}),
        ...(q.collegeId ? { collegeId: q.collegeId } : {}),
        ...(q.jobRoleId ? { round: { jobRoleId: q.jobRoleId } } : {}),
        ...(q.active !== undefined ? { active: q.active } : {}),
      },
      include: driveInclude,
      orderBy: driveOrder,
    });
    return toDrives(rows);
  },

  async findDrive(id) {
    return one(await prisma.drive.findUnique({ where: { id }, include: driveInclude }));
  },

  async createDrive(data, audit) {
    const id = await unique(
      () =>
        prisma.$transaction(async (tx) => {
          const row = await tx.drive.create({ data, select: { id: true } });
          await writeAudit(tx, audit(row.id));
          return row.id;
        }),
      DRIVE_TAKEN,
    );
    return (await this.findDrive(id))!;
  },

  async updateDrive(id, data, audit) {
    await unique(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.drive.update({ where: { id }, data, select: { id: true } });
          await writeAudit(tx, audit);
        }),
      DRIVE_TAKEN,
    );
    return (await this.findDrive(id))!;
  },

  async nextRound(roundId) {
    const round = await prisma.examRound.findUniqueOrThrow({ where: { id: roundId }, select: { jobRoleId: true, roundNumber: true } });
    return prisma.examRound.findUnique({
      where: { jobRoleId_roundNumber: { jobRoleId: round.jobRoleId, roundNumber: round.roundNumber + 1 } },
      select: { id: true },
    });
  },

  async promote(sourceDriveId, target, audit) {
    const shortlisted = await prisma.candidate.count({ where: { driveId: sourceDriveId, result: 'SHORTLISTED' } });
    // Codes come from the sequence outside the transaction; unused ones are simply skipped numbers.
    const codes = await nextCandidateCodes(shortlisted);
    return prisma.$transaction(async (tx) => {
      const rows = await tx.candidate.findMany({ where: { driveId: sourceDriveId, result: 'SHORTLISTED' }, orderBy: { id: 'asc' } });
      const accountIds = [...new Set(rows.map((r) => r.accountId))];
      if (accountIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM candidate_accounts WHERE id = ANY(${accountIds}::uuid[]) ORDER BY id FOR UPDATE`;
      }
      const result: PromoteResultDto = { targetDriveId: target.id, moved: 0, alreadyThere: 0, skipped: [] };
      for (const c of rows) {
        if ((await tx.candidate.count({ where: { accountId: c.accountId, driveId: target.id } })) > 0) {
          result.alreadyThere += 1;
          continue;
        }
        if (await siblingEntry(tx, c.accountId, target.id)) {
          result.skipped.push({ candidateId: c.id, candidateCode: c.candidateCode, reason: 'SAME_ROUND_BATCH' });
          continue;
        }
        const created = await tx.candidate.create({
          data: {
            accountId: c.accountId,
            candidateCode: codes[result.moved]!,
            fullName: c.fullName,
            email: c.email,
            mobile: c.mobile,
            rollNumber: c.rollNumber,
            xPercentage: c.xPercentage,
            xiiPercentage: c.xiiPercentage,
            majorCpi: c.majorCpi,
            discipline: c.discipline,
            programme: c.programme,
            extra: c.extra as Prisma.InputJsonValue,
            eligible: c.eligible,
            locationExempt: c.locationExempt,
            jobRoleId: target.jobRoleId,
            driveId: target.id,
            promotedFromId: c.id,
          },
          select: { id: true },
        });
        await writeAudit(tx, audit.entry(created.id, c.id));
        result.moved += 1;
      }
      await writeAudit(tx, audit.run(result));
      return result;
    });
  },

  async findDriveFor(roundId, collegeId, batch) {
    return one(
      await prisma.drive.findFirst({
        where: { roundId, collegeId, batch: { equals: batch.trim(), mode: 'insensitive' } },
        include: driveInclude,
      }),
    );
  },
};

/**
 * What the exam engine needs to start a drive's test: the drive's window,
 * open switch and instructions; the round's duration; the job profile type and
 * how many rounds it has (the candidate sees the round only when above 1).
 */
export async function driveExamSettings(driveId: string) {
  const d = await prisma.drive.findUnique({
    where: { id: driveId },
    select: {
      windowStart: true,
      windowEnd: true,
      isOpen: true,
      instructions: true,
      roundId: true,
      round: { select: { roundNumber: true, durationMinutes: true, mcqNegativeMarks: true, jobRole: { select: { type: true, _count: { select: { rounds: true } } } } } },
    },
  });
  if (!d) return null;
  return {
    durationMinutes: d.round.durationMinutes,
    isOpen: d.isOpen,
    windowStart: d.windowStart,
    windowEnd: d.windowEnd,
    instructions: d.instructions,
    roundId: d.roundId,
    roundNumber: d.round.roundNumber,
    roundCount: d.round.jobRole._count.rounds,
    jobProfileType: d.round.jobRole.type,
    mcqNegativeMarks: Number(d.round.mcqNegativeMarks),
  };
}
