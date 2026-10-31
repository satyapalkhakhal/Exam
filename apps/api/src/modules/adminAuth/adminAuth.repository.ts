// modules/adminAuth/adminAuth.repository.ts
// admin_users access for sign-in: lookups plus the failure counter and lock.
// The counter is incremented in SQL so parallel wrong passwords all count.

import { prisma } from '../../infrastructure/db/prisma.js';
import type { AdminAuthRecord, AdminAuthRepository } from './adminAuth.service.js';

const select = {
  id: true,
  email: true,
  mobile: true,
  name: true,
  role: true,
  active: true,
  passwordHash: true,
  failedLoginCount: true,
  lockedUntil: true,
} as const;

export const adminAuthRepository: AdminAuthRepository = {
  async findByEmail(email): Promise<AdminAuthRecord | null> {
    return prisma.adminUser.findUnique({ where: { email }, select });
  },
  async findById(id): Promise<AdminAuthRecord | null> {
    return prisma.adminUser.findUnique({ where: { id }, select });
  },
  async registerFailure(id) {
    const row = await prisma.adminUser.update({
      where: { id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    return row.failedLoginCount;
  },
  async lock(id, until) {
    await prisma.adminUser.update({ where: { id }, data: { lockedUntil: until, failedLoginCount: 0 } });
  },
  async clearFailures(id) {
    await prisma.adminUser.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: null } });
  },
  async markLoggedIn(id, at) {
    await prisma.adminUser.update({ where: { id }, data: { lastLoginAt: at } });
  },
};
