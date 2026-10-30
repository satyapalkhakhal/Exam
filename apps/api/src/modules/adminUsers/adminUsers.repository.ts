// modules/adminUsers/adminUsers.repository.ts
// admin_users CRUD for the Super Admin screens. Writes and their audit rows run
// in one transaction; the last-Super-Admin check locks the active Super Admin
// rows (FOR UPDATE) so concurrent demotions serialise on it.

import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';
import { writeAudit } from '../audit/index.js';
import type { AdminUsersRepository } from './adminUsers.service.js';

const select = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  lastLoginAt: true,
  lockedUntil: true,
  createdAt: true,
} as const;

const LAST_SUPER_ADMIN = 'There must be at least one active Super Admin.';

export const adminUsersRepository: AdminUsersRepository = {
  async list(skip, take) {
    const [items, total] = await prisma.$transaction([
      prisma.adminUser.findMany({ select, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip, take }),
      prisma.adminUser.count(),
    ]);
    return { items, total };
  },

  async findById(id) {
    return prisma.adminUser.findUnique({ where: { id }, select });
  },

  async findByEmail(email) {
    return prisma.adminUser.findUnique({ where: { email }, select });
  },

  async create(data, audit) {
    try {
      return await prisma.$transaction(async (tx) => {
        const row = await tx.adminUser.create({ data, select });
        await writeAudit(tx, audit(row.id));
        return row;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('An admin with this email already exists.');
      }
      throw err;
    }
  },

  async update(id, data, opts, audit) {
    return prisma.$transaction(async (tx) => {
      if (opts.keepAnotherSuperAdmin) {
        const supers = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM admin_users WHERE role = 'SUPER_ADMIN' AND active = true FOR UPDATE`;
        if (!supers.some((s) => s.id !== id)) throw conflict(LAST_SUPER_ADMIN);
      }
      const row = await tx.adminUser.update({ where: { id }, data, select });
      await writeAudit(tx, audit);
      return row;
    });
  },
};
