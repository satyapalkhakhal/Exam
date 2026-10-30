// modules/candidates/candidates.repository.ts
// candidates + their logs. Every write commits with its audit row. The unique
// email/mobile indexes are the final arbiter of duplicates, so concurrent
// imports or edits cannot slip one past the service.

import type { CandidateListQuery } from '@exam/shared';
import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import type { CandidatesRepository } from './candidates.service.js';

const include = { jobRole: { select: { name: true } } } as const;
const isUnique = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

function listWhere(q: CandidateListQuery): Prisma.CandidateWhereInput {
  return {
    ...(q.jobRoleId ? { jobRoleId: q.jobRoleId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.search
      ? {
          OR: [
            { fullName: { contains: q.search, mode: 'insensitive' } },
            { email: { contains: q.search, mode: 'insensitive' } },
            { rollNumber: { contains: q.search, mode: 'insensitive' } },
            { candidateCode: { contains: q.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

export const candidatesRepository: CandidatesRepository = {
  async jobRoleExists(id) {
    return (await prisma.jobRole.count({ where: { id } })) > 0;
  },

  async rolesByLowerName() {
    const roles = await prisma.jobRole.findMany({ select: { id: true, name: true } });
    return new Map(roles.map((r) => [r.name.trim().toLowerCase(), r.id]));
  },

  async existingEmailsAndMobiles() {
    const rows = await prisma.candidate.findMany({ select: { email: true, mobile: true } });
    return {
      emails: new Set(rows.map((r) => r.email.toLowerCase())),
      mobiles: new Set(rows.flatMap((r) => (r.mobile ? [r.mobile] : []))),
    };
  },

  async lastImportOf(jobRoleId, fileHash) {
    const batch = await prisma.importBatch.findFirst({
      where: { kind: 'CANDIDATES', jobRoleId, fileHash },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return batch?.createdAt ?? null;
  },

  confirmImport(input) {
    return prisma.$transaction(async (tx) => {
      const batch = await tx.importBatch.create({
        data: {
          kind: 'CANDIDATES',
          jobRoleId: input.jobRoleId,
          fileName: input.fileName,
          fileHash: input.fileHash,
          uploadedById: input.uploadedById,
          total: input.total,
          errors: input.errors as Prisma.InputJsonValue,
        },
      });
      const { count } = await tx.candidate.createMany({
        data: input.rows.map((r) => ({
          candidateCode: r.candidateCode,
          fullName: r.fullName,
          email: r.email,
          mobile: r.mobile,
          rollNumber: r.rollNumber,
          xPercentage: r.xPercentage,
          xiiPercentage: r.xiiPercentage,
          majorCpi: r.majorCpi,
          discipline: r.discipline,
          programme: r.programme,
          extra: r.extra as Prisma.InputJsonValue,
          jobRoleId: r.jobRoleId,
          importBatchId: batch.id,
        })),
        skipDuplicates: true,
      });
      await tx.importBatch.update({ where: { id: batch.id }, data: { imported: count, skipped: input.total - count } });
      await writeAudit(tx, input.audit(count));
      return count;
    });
  },

  async possiblyFlaggedIds(q) {
    // Every review flag needs integrity events or an exam-start location row.
    const rows = await prisma.candidate.findMany({
      where: { AND: [listWhere(q), { OR: [{ activityLogs: { some: {} } }, { loginLogs: { some: { stage: 'EXAM_START' } } }] }] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  },

  async list(q, ids) {
    const where: Prisma.CandidateWhereInput = ids ? { AND: [listWhere(q), { id: ids }] } : listWhere(q);
    const orderBy: Prisma.CandidateOrderByWithRelationInput[] = [
      { [q.sort]: { sort: q.dir, nulls: 'last' } } as Prisma.CandidateOrderByWithRelationInput,
      { id: 'asc' },
    ];
    if (q.sort === 'fullName' || q.sort === 'createdAt') orderBy[0] = { [q.sort]: q.dir };
    const [rows, total] = await prisma.$transaction([
      prisma.candidate.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include }),
      prisma.candidate.count({ where }),
    ]);
    return { rows, total };
  },

  async detail(id, skip, take) {
    const candidate = await prisma.candidate.findUnique({ where: { id }, include });
    if (!candidate) return null;
    const [loginLogs, attempt, rows, total, history] = await prisma.$transaction([
      prisma.candidateLoginLog.findMany({ where: { candidateId: id }, orderBy: { createdAt: 'desc' }, take: 200 }),
      prisma.examAttempt.findFirst({
        where: { candidateId: id, status: { not: 'RESET' } },
        select: { id: true, status: true, startedAt: true, submittedAt: true },
      }),
      prisma.activityLog.findMany({ where: { candidateId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take }),
      prisma.activityLog.count({ where: { candidateId: id } }),
      prisma.candidateStatusHistory.findMany({
        where: { candidateId: id },
        orderBy: { createdAt: 'desc' },
        include: { byAdmin: { select: { name: true } } },
      }),
    ]);
    return { candidate, loginLogs, attempt, activity: { rows, total }, history };
  },

  findById(id) {
    return prisma.candidate.findUnique({ where: { id }, include });
  },

  async update(id, data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        const row = await tx.candidate.update({ where: { id }, data, include });
        await writeAudit(tx, audit);
        return row;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict('Another candidate already has this email or mobile.');
      throw err;
    }
  },

  setEligible(id, eligible, audit) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.candidate.update({ where: { id }, data: { eligible }, include });
      await writeAudit(tx, audit);
      return row;
    });
  },

  setLocationExempt(id, exempt, audit) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.candidate.update({ where: { id }, data: { locationExempt: exempt }, include });
      await writeAudit(tx, audit);
      return row;
    });
  },

  resetAttempt(id, adminId, reason, audit) {
    return prisma.$transaction(async (tx) => {
      // Candidate row first, as evaluation submit/reopen and decisions do, so a
      // reset racing them reads their committed status rather than a stale one.
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${id}::uuid FOR UPDATE`;
      const attempt = await tx.examAttempt.findFirst({ where: { candidateId: id, status: { not: 'RESET' } }, select: { id: true } });
      if (!attempt) return false;
      const candidate = await tx.candidate.findUniqueOrThrow({ where: { id }, select: { status: true } });
      await tx.examAttempt.update({ where: { id: attempt.id }, data: { status: 'RESET' } });
      await tx.candidate.update({ where: { id }, data: { status: 'NOT_STARTED' } });
      await tx.candidateStatusHistory.create({
        data: { candidateId: id, fromStatus: candidate.status, toStatus: 'NOT_STARTED', byAdminId: adminId, comment: reason },
      });
      await writeAudit(tx, audit);
      return true;
    });
  },
};
