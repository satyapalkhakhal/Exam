// modules/questions/questions.repository.ts
// questions + import_batches access. Every write commits with its audit row;
// the unique (job_role_id, normalized_text_hash) index is the final arbiter of
// duplicates, so concurrent creates cannot slip a duplicate past the service.

import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError, conflict } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import type { QuestionsRepository } from './questions.service.js';

const DUPLICATE = 'This question already exists for the role.';
const isUnique = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const order = [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] as const satisfies Prisma.QuestionOrderByWithRelationInput[];

/**
 * Takes the role's exam_settings row FOR UPDATE and fails with 423 when the
 * questions are locked. Exam start (Task 10) takes the same lock before it sets
 * the flag, so a write and a start serialise: either the write commits first or
 * it sees the lock.
 */
export async function withRoleSettingsLock(tx: Prisma.TransactionClient, jobRoleId: string): Promise<void> {
  if ((await lockRoleSettings(tx, jobRoleId))?.questionsLocked) {
    throw new AppError(423, 'QUESTIONS_LOCKED', 'Questions are locked for this role. A Super Admin can unlock them.');
  }
}

/**
 * The same exam_settings row lock without the "locked" refusal, for exam start:
 * once someone has started, the role is locked and later starts must still
 * succeed. Returns null when the role has no settings row.
 */
export async function lockRoleSettings(
  tx: Prisma.TransactionClient,
  jobRoleId: string,
): Promise<{ questionsLocked: boolean } | null> {
  const rows = await tx.$queryRaw<{ questions_locked: boolean }[]>`
    SELECT questions_locked FROM exam_settings WHERE job_role_id = ${jobRoleId}::uuid FOR UPDATE`;
  const row = rows[0];
  return row ? { questionsLocked: row.questions_locked } : null;
}

export const questionsRepository: QuestionsRepository = {
  async roleLockState(jobRoleId) {
    const role = await prisma.jobRole.findUnique({
      where: { id: jobRoleId },
      select: { examSetting: { select: { questionsLocked: true } } },
    });
    return role ? { locked: role.examSetting?.questionsLocked ?? false } : null;
  },

  findById(id) {
    return prisma.question.findUnique({ where: { id } });
  },

  async list(jobRoleId, skip, take) {
    const [rows, total] = await prisma.$transaction([
      prisma.question.findMany({ where: { jobRoleId }, orderBy: [...order], skip, take }),
      prisma.question.count({ where: { jobRoleId } }),
    ]);
    return { rows, total };
  },

  async existingHashes(jobRoleId) {
    const rows = await prisma.question.findMany({ where: { jobRoleId }, select: { normalizedTextHash: true } });
    return new Set(rows.map((r) => r.normalizedTextHash));
  },

  async maxDisplayOrder(jobRoleId) {
    const agg = await prisma.question.aggregate({ where: { jobRoleId }, _max: { displayOrder: true } });
    return agg._max.displayOrder ?? 0;
  },

  async create(data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        await withRoleSettingsLock(tx, data.jobRoleId);
        const row = await tx.question.create({ data });
        await writeAudit(tx, audit(row.id));
        return row;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(DUPLICATE);
      throw err;
    }
  },

  async update(id, jobRoleId, data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        await withRoleSettingsLock(tx, jobRoleId);
        const row = await tx.question.update({ where: { id }, data });
        await writeAudit(tx, audit);
        return row;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(DUPLICATE);
      throw err;
    }
  },

  setActive(id, jobRoleId, active, audit) {
    return prisma.$transaction(async (tx) => {
      await withRoleSettingsLock(tx, jobRoleId);
      const row = await tx.question.update({ where: { id }, data: { active } });
      await writeAudit(tx, audit);
      return row;
    });
  },

  reorder(jobRoleId, ids, audit) {
    return prisma.$transaction(async (tx) => {
      await withRoleSettingsLock(tx, jobRoleId);
      const found = await tx.question.count({ where: { jobRoleId, id: { in: ids } } });
      if (found !== ids.length) return false;
      for (const [i, id] of ids.entries()) {
        await tx.question.update({ where: { id }, data: { displayOrder: i + 1 } });
      }
      await writeAudit(tx, audit);
      return true;
    });
  },

  async unlock(jobRoleId, audit) {
    await prisma.$transaction(async (tx) => {
      await tx.examSetting.upsert({
        where: { jobRoleId },
        create: { jobRoleId, questionsLocked: false },
        update: { questionsLocked: false },
      });
      await writeAudit(tx, audit);
    });
  },

  async lastImportOf(jobRoleId, fileHash) {
    const batch = await prisma.importBatch.findFirst({
      where: { kind: 'QUESTIONS', jobRoleId, fileHash },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return batch?.createdAt ?? null;
  },

  confirmImport(input) {
    return prisma.$transaction(async (tx) => {
      await withRoleSettingsLock(tx, input.jobRoleId);
      const { count } = await tx.question.createMany({ data: input.rows, skipDuplicates: true });
      await tx.importBatch.create({
        data: {
          kind: 'QUESTIONS',
          jobRoleId: input.jobRoleId,
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
