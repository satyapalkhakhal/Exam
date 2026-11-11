// modules/jobRoles/jobRoles.repository.ts
// job_roles access. A role and its Round 1 are created together, and every
// write commits with its audit row. (lower(name), type) is unique through the
// raw index job_roles_name_type_key, which Prisma reports as P2002.

import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import { toRoundRow } from '../drives/drives.repository.js';
import type { JobRoleRow, JobRolesRepository } from './jobRoles.service.js';

const include = {
  rounds: { include: { _count: { select: { questions: true } } }, orderBy: { roundNumber: 'asc' } },
  _count: { select: { candidates: true } },
} as const;
type Record_ = Prisma.JobRoleGetPayload<{ include: typeof include }>;

const toRow = (r: Record_): JobRoleRow => ({
  id: r.id,
  name: r.name,
  type: r.type,
  refApplicantCount: r.refApplicantCount,
  active: r.active,
  rounds: r.rounds.map(toRoundRow),
  candidateCount: r._count.candidates,
});

const NAME_TAKEN = 'A job profile with this name and type already exists.';
const isUnique = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export const jobRolesRepository: JobRolesRepository = {
  async list() {
    const rows = await prisma.jobRole.findMany({ include, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(toRow);
  },

  async findById(id) {
    const row = await prisma.jobRole.findUnique({ where: { id }, include });
    return row ? toRow(row) : null;
  },

  async create(data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        const row = await tx.jobRole.create({ data: { ...data, rounds: { create: { roundNumber: 1 } } }, include });
        await writeAudit(tx, audit(row.id));
        return toRow(row);
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
        return toRow(row);
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(NAME_TAKEN);
      throw err;
    }
  },
};
