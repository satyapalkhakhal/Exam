// modules/questions/questions.repository.ts
// questions + import_batches access. Every write commits with its audit row;
// the unique (round_id, normalized_text_hash) index is the final arbiter of
// duplicates, so concurrent creates cannot slip a duplicate past the service.

import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError, badRequest, conflict } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import type { QuestionsRepository } from './questions.service.js';

const DUPLICATE = 'This question already exists in this round.';
const isUnique = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const order = [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] as const satisfies Prisma.QuestionOrderByWithRelationInput[];

/**
 * Takes the round's exam_rounds row FOR UPDATE and fails with 423 when its
 * questions are locked. Exam start takes the same row lock before it sets the
 * flag, so a write and a start serialise: either the write commits first or it
 * sees the lock. The lock is per round, so a start in any college's drive of
 * the round locks the questions for all of them.
 */
export async function withRoundLock(tx: Prisma.TransactionClient, roundId: string): Promise<void> {
  if ((await lockRound(tx, roundId))?.questionsLocked) {
    throw new AppError(423, 'QUESTIONS_LOCKED', 'Questions are locked for this round. A Super Admin can unlock them.');
  }
}

/** The exam_rounds row lock without the "locked" refusal. Null when the round does not exist. */
export async function lockRound(tx: Prisma.TransactionClient, roundId: string): Promise<{ questionsLocked: boolean } | null> {
  const rows = await tx.$queryRaw<{ questions_locked: boolean }[]>`
    SELECT questions_locked FROM exam_rounds WHERE id = ${roundId}::uuid FOR UPDATE`;
  const row = rows[0];
  return row ? { questionsLocked: row.questions_locked } : null;
}

/**
 * Review I2: an active MCQ may never be worth less than the round's negative marking (a wrong
 * answer would cost more than a right one earns). Run inside the write's transaction, after the
 * write and with the round row already held by withRoundLock, scoped to the rows just written
 * so a round that is already off (older data) can still be fixed. Throws 400 to roll back.
 */
export async function assertMcqCap(tx: Prisma.TransactionClient, roundId: string, written: { ids?: string[]; hashes?: string[] }): Promise<void> {
  const rows = await tx.$queryRaw<{ mcq_negative_marks: Prisma.Decimal }[]>`SELECT mcq_negative_marks FROM exam_rounds WHERE id = ${roundId}::uuid`;
  const negative = rows[0] ? Number(rows[0].mcq_negative_marks) : 0;
  if (negative <= 0) return;
  const which: Prisma.QuestionWhereInput[] = [
    ...(written.ids?.length ? [{ id: { in: written.ids } }] : []),
    ...(written.hashes?.length ? [{ normalizedTextHash: { in: written.hashes } }] : []),
  ];
  if (which.length === 0) return;
  const below = await tx.question.count({ where: { roundId, type: 'MCQ', active: true, maxMarks: { lt: negative }, OR: which } });
  if (below > 0) {
    throw badRequest(
      `Negative marking for this round is ${negative} per wrong answer, so every MCQ must be worth at least ${negative} marks. Raise the marks, or lower the negative marking first.`,
    );
  }
}

export const questionsRepository: QuestionsRepository = {
  async roundLockState(roundId) {
    const round = await prisma.examRound.findUnique({ where: { id: roundId }, select: { questionsLocked: true } });
    return round ? { locked: round.questionsLocked } : null;
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
        await assertMcqCap(tx, data.roundId, { ids: [row.id] });
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
        await assertMcqCap(tx, roundId, { ids: [id] });
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
      if (active) await assertMcqCap(tx, roundId, { ids: [id] });
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
      await tx.examRound.update({ where: { id: roundId }, data: { questionsLocked: false } });
      await writeAudit(tx, audit);
    });
  },

  async lastImportOf(roundId, fileHash) {
    const batch = await prisma.importBatch.findFirst({
      where: { kind: 'QUESTIONS', roundId, fileHash },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return batch?.createdAt ?? null;
  },

  confirmImport(input) {
    return prisma.$transaction(async (tx) => {
      await withRoundLock(tx, input.roundId);
      const { count } = await tx.question.createMany({ data: input.rows, skipDuplicates: true });
      await assertMcqCap(tx, input.roundId, { hashes: input.rows.map((r) => r.normalizedTextHash) });
      await tx.importBatch.create({
        data: {
          kind: 'QUESTIONS',
          roundId: input.roundId,
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

  copyQuestions(input) {
    return prisma.$transaction(async (tx) => {
      await withRoundLock(tx, input.targetRoundId);
      if (input.replace) {
        await tx.question.updateMany({ where: { roundId: input.targetRoundId, active: true }, data: { active: false } });
      } else if ((await tx.question.count({ where: { roundId: input.targetRoundId } })) > 0) {
        throw conflict('This round already has questions. Choose "Replace" to deactivate them first.', 'TARGET_HAS_QUESTIONS');
      }
      const source = await tx.question.findMany({ where: { roundId: input.fromRoundId, active: true }, orderBy: [...order] });
      const max = await tx.question.aggregate({ where: { roundId: input.targetRoundId }, _max: { displayOrder: true } });
      const base = max._max.displayOrder ?? 0;
      // With "replace" the target's questions were just deactivated; one with the same text
      // (unique per round, active or not) is re-activated and refreshed from the source
      // instead of being skipped, so a refresh never leaves the round without them.
      const existing = new Map(
        (await tx.question.findMany({ where: { roundId: input.targetRoundId }, select: { id: true, normalizedTextHash: true } })).map((q) => [q.normalizedTextHash, q.id]),
      );
      const written: string[] = [];
      for (const [i, q] of source.entries()) {
        const fields = {
          text: q.text,
          type: q.type,
          options: q.options,
          correctOption: q.correctOption,
          maxMarks: q.maxMarks,
          evaluatorGuidance: q.evaluatorGuidance,
          displayOrder: base + i + 1,
          active: true,
        };
        const id = existing.get(q.normalizedTextHash);
        if (id) await tx.question.update({ where: { id }, data: fields });
        else await tx.question.create({ data: { ...fields, roundId: input.targetRoundId, normalizedTextHash: q.normalizedTextHash } });
        written.push(q.normalizedTextHash);
      }
      await assertMcqCap(tx, input.targetRoundId, { hashes: written });
      await writeAudit(tx, input.audit(source.length));
      return { copied: source.length, skippedDuplicates: 0 };
    });
  },
};
