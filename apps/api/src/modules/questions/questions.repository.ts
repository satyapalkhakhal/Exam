// modules/questions/questions.repository.ts
// questions + import_batches access. Every write commits with its audit row;
// the unique (round_id, normalized_text_hash) index is the final arbiter of
// duplicates, so concurrent creates cannot slip a duplicate past the service.

import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError, conflict } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import type { QuestionsRepository } from './questions.service.js';

const DUPLICATE = 'This question already exists in this round.';
const isUnique = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const order = [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] as const satisfies Prisma.QuestionOrderByWithRelationInput[];

/**
 * Takes the round's exam_rounds row FOR UPDATE and fails with 423 when its
 * questions are locked. Exam start takes the same lock before it sets the flag,
 * so a write and a start serialise: either the write commits first or it sees
 * the lock.
 */
export async function withRoundLock(tx: Prisma.TransactionClient, roundId: string): Promise<void> {
  if ((await lockRound(tx, roundId))?.questionsLocked) {
    throw new AppError(423, 'QUESTIONS_LOCKED', 'Questions are locked for this round. A Super Admin can unlock them.');
  }
}

/**
 * The same exam_rounds row lock without the "locked" refusal, for exam start:
 * once someone has started, the round is locked and later starts must still
 * succeed. Returns null when the round does not exist.
 */
export async function lockRound(
  tx: Prisma.TransactionClient,
  roundId: string,
): Promise<{ questionsLocked: boolean } | null> {
  const rows = await tx.$queryRaw<{ questions_locked: boolean }[]>`
    SELECT questions_locked FROM exam_rounds WHERE id = ${roundId}::uuid FOR UPDATE`;
  const row = rows[0];
  return row ? { questionsLocked: row.questions_locked } : null;
}

export const questionsRepository: QuestionsRepository = {
  async roundState(roundId) {
    const round = await prisma.examRound.findUnique({
      where: { id: roundId },
      select: { examId: true, questionsLocked: true },
    });
    return round ? { examId: round.examId, locked: round.questionsLocked } : null;
  },

  findById(id) {
    return prisma.question.findUnique({ where: { id } });
  },

  async list(roundId, skip, take) {
    const [rows, total] = await prisma.$transaction([
      prisma.question.findMany({ where: { roundId }, orderBy: [...order], skip, take }),
      prisma.question.count({ where: { roundId } }),
    ]);
    return { rows, total };
  },

  async existingHashes(roundId) {
    const rows = await prisma.question.findMany({ where: { roundId }, select: { normalizedTextHash: true } });
    return new Set(rows.map((r) => r.normalizedTextHash));
  },

  async maxDisplayOrder(roundId) {
    const agg = await prisma.question.aggregate({ where: { roundId }, _max: { displayOrder: true } });
    return agg._max.displayOrder ?? 0;
  },

  async create(data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        await withRoundLock(tx, data.roundId);
        const row = await tx.question.create({ data });
        await writeAudit(tx, audit(row.id));
        return row;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(DUPLICATE);
      throw err;
    }
  },

  async update(id, roundId, data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        await withRoundLock(tx, roundId);
        const row = await tx.question.update({ where: { id }, data });
        await writeAudit(tx, audit);
        return row;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(DUPLICATE);
      throw err;
    }
  },

  setActive(id, roundId, active, audit) {
    return prisma.$transaction(async (tx) => {
      await withRoundLock(tx, roundId);
      const row = await tx.question.update({ where: { id }, data: { active } });
      await writeAudit(tx, audit);
      return row;
    });
  },

  reorder(roundId, ids, audit) {
    return prisma.$transaction(async (tx) => {
      await withRoundLock(tx, roundId);
      const found = await tx.question.count({ where: { roundId, id: { in: ids } } });
      if (found !== ids.length) return false;
      for (const [i, id] of ids.entries()) {
        await tx.question.update({ where: { id }, data: { displayOrder: i + 1 } });
      }
      await writeAudit(tx, audit);
      return true;
    });
  },

  async unlock(roundId, audit) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM exam_rounds WHERE id = ${roundId}::uuid FOR UPDATE`;
      await tx.examRound.update({ where: { id: roundId }, data: { questionsLocked: false } });
      await writeAudit(tx, audit);
    });
  },

  async lastImportOf(examId, fileHash) {
    const batch = await prisma.importBatch.findFirst({
      where: { kind: 'QUESTIONS', examId, fileHash },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return batch?.createdAt ?? null;
  },

  confirmImport(input) {
    return prisma.$transaction(async (tx) => {
      await withRoundLock(tx, input.roundId);
      const { count } = await tx.question.createMany({ data: input.rows, skipDuplicates: true });
      await tx.importBatch.create({
        data: {
          kind: 'QUESTIONS',
          examId: input.examId,
          fileName: input.fileName,
          fileHash: input.fileHash,
          uploadedById: input.uploadedById,
          total: input.total,
          imported: count,
          skipped: input.total - count,
          errors: input.errors as Prisma.InputJsonValue,
        },
      });
      await writeAudit(tx, input.audit(count));
      return count;
    });
  },
};
