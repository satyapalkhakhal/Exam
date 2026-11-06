// modules/jobRoles/jobRoles.repository.ts
// job_roles + exam_settings access. A role and its default settings row are
// created together, and every write commits with its audit row.

import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import type { JobRolesRepository } from './jobRoles.service.js';

const settingSelect = {
  durationMinutes: true,
  windowStart: true,
  windowEnd: true,
  instructions: true,
  isOpen: true,
  questionsLocked: true,
  weightExam: true,
  weightX: true,
  weightXii: true,
  weightCpi: true,
} as const;

const include = {
  examSetting: { select: settingSelect },
  _count: { select: { questions: true, candidates: true } },
} as const;

const NAME_TAKEN = 'A job role with this name already exists.';
const isUnique = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export const jobRolesRepository: JobRolesRepository = {
  list() {
    return prisma.jobRole.findMany({ include, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  },

  findById(id) {
    return prisma.jobRole.findUnique({ where: { id }, include });
  },

  async create(data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        const row = await tx.jobRole.create({ data: { ...data, examSetting: { create: {} } }, include });
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
        const row = await tx.jobRole.update({ where: { id }, data, include });
        await writeAudit(tx, audit);
        return row;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(NAME_TAKEN);
      throw err;
    }
  },

  async upsertSettings(jobRoleId, data, audit) {
    const { weights, ...rest } = data;
    const w = weights ? { weightExam: weights.exam, weightX: weights.x, weightXii: weights.xii, weightCpi: weights.cpi } : {};
    return prisma.$transaction(async (tx) => {
      const row = await tx.examSetting.upsert({
        where: { jobRoleId },
        create: { jobRoleId, ...rest, ...w },
        update: { ...rest, ...w },
        select: settingSelect,
      });
      await writeAudit(tx, audit);
      return row;
    });
  },

  getSettings(jobRoleId) {
    return prisma.examSetting.findUnique({ where: { jobRoleId }, select: settingSelect });
  },
};
