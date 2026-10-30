// modules/adminUsers/index.ts
// Barrel: admin user management on the Prisma repository, bcrypt cost 12.

import bcrypt from 'bcrypt';
import { revokeAllSessions } from '../adminAuth/index.js';
import { adminUsersRepository } from './adminUsers.repository.js';
import { createAdminUsersService } from './adminUsers.service.js';

export { createAdminUsersRouter } from './adminUsers.routes.js';
export { createAdminUsersService, ADMIN_USERS_PAGE_SIZE } from './adminUsers.service.js';
export type { AdminUsersService, AdminUsersRepository, AdminUserRow, AdminUserChanges } from './adminUsers.service.js';
export { adminUsersRepository };

export const BCRYPT_ROUNDS = 12;
export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, BCRYPT_ROUNDS);

export const adminUsersService = createAdminUsersService({
  repo: adminUsersRepository,
  hashPassword,
  revokeSessions: (adminId) => revokeAllSessions('admin', adminId),
});
