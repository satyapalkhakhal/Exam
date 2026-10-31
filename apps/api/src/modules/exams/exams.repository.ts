// modules/exams/exams.repository.ts
// exams + exam_rounds access. Every write commits with its audit row. Adding a
// round and editing round settings serialise on a row lock (exam / round).

import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { conflict, notFound } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import { backfillNewRound } from '../rounds/qualification.js';
import type { ExamsRepository } from './exams.service.js';

const roundInclude = { _count: { select: { questions: true, entries: true } } } as const;
const include = {
  jobRole: { select: { name: true } },
  rounds: { include: roundInclude, orderBy: { roundNumber: 'asc' } },
} as const;

const NAME_TAKEN = 'An exam with this name already exists.';
const isUnique = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export const examsRepository: ExamsRepository = {
  list({ jobRoleId, active }) {
    return prisma.exam.findMany({
      where: { ...(jobRoleId ? { jobRoleId } : {}), ...(active !== undefined ? { active } : {}) },
      include,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  findById(id) {
    return prisma.exam.findUnique({ where: { id }, include });
  },

  async jobRoleExists(id) {
    return (await prisma.jobRole.count({ where: { id } })) > 0;
  },

  async create(data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        const row = await tx.exam.create({ data, include });
        await writeAudit(tx, audit(row.id));
        return row;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(NAME_TAKEN);
      throw err;
    }
  },

  async update(id, data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        const row = await tx.exam.update({ where: { id }, data, include });
        await writeAudit(tx, audit);
        return row;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(NAME_TAKEN);
      throw err;
    }
  },

  addRound(examId, name, adminId, audit) {
    return prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM exams WHERE id = ${examId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw notFound('Exam not found');
      const max = await tx.examRound.aggregate({ where: { examId }, _max: { roundNumber: true } });
      const roundNumber = (max._max.roundNumber ?? 0) + 1;
      const created = await tx.examRound.create({ data: { examId, roundNumber, name }, select: { id: true } });
      const backfilled = await backfillNewRound(tx, created.id, adminId);
      await writeAudit(tx, audit({ id: created.id, roundNumber }, backfilled));
      return tx.examRound.findUniqueOrThrow({ where: { id: created.id }, include: roundInclude });
    });
  },

  updateRoundSettings(roundId, data, audit) {
    return prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM exam_rounds WHERE id = ${roundId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw notFound('Round not found');
      const row = await tx.examRound.update({ where: { id: roundId }, data, include: roundInclude });
      await writeAudit(tx, audit);
      return row;
    });
  },
};
