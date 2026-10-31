// modules/jobRoles/jobRoles.repository.ts
// job_roles access; every write commits with its audit row.

import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import type { JobRolesRepository } from './jobRoles.service.js';

const include = { _count: { select: { exams: true } } } as const;

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
        const row = await tx.jobRole.create({ data, include });
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
};
