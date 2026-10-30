// modules/adminUsers/adminUsers.service.ts
// Super Admin management of admin accounts. Guard rails: a Super Admin cannot
// deactivate themselves, and the last active Super Admin can be neither
// demoted nor deactivated (the repository re-checks that under a row lock, so
// two concurrent demotions cannot both win). A password reset also clears the
// lockout. Every change is audited in the same transaction, without the password.
// A password reset, a deactivation or a role change also signs the target out
// everywhere (all refresh families and access tokens issued so far), so a
// re-activation never revives an old session.

import type { AdminRole, AdminUserCreateInput, AdminUserUpdateInput, Paginated } from '@exam/shared';
import { conflict, notFound } from '../../shared/errors.js';
import type { AuditRecord } from '../audit/index.js';

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  active: boolean;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
}

export interface AdminUserChanges {
  name?: string;
  role?: AdminRole;
  active?: boolean;
  passwordHash?: string;
  failedLoginCount?: number;
  lockedUntil?: null;
}

export interface AdminUsersRepository {
  list(skip: number, take: number): Promise<{ items: AdminUserRow[]; total: number }>;
  findById(id: string): Promise<AdminUserRow | null>;
  findByEmail(email: string): Promise<AdminUserRow | null>;
  /** Throws CONFLICT when the email is taken. */
  create(data: { name: string; email: string; role: AdminRole; passwordHash: string }, audit: (id: string) => AuditRecord): Promise<AdminUserRow>;
  /** With keepAnotherSuperAdmin, throws CONFLICT unless another active Super Admin remains. */
  update(id: string, data: AdminUserChanges, opts: { keepAnotherSuperAdmin: boolean }, audit: AuditRecord): Promise<AdminUserRow>;
}

export interface AdminUsersDeps {
  repo: AdminUsersRepository;
  hashPassword: (plain: string) => Promise<string>;
  revokeSessions: (adminId: string) => Promise<void>;
}

export const ADMIN_USERS_PAGE_SIZE = 20;
const ENTITY = 'admin_user';

export function createAdminUsersService(deps: AdminUsersDeps) {
  async function list(page: number): Promise<Paginated<AdminUserRow>> {
    const { items, total } = await deps.repo.list((page - 1) * ADMIN_USERS_PAGE_SIZE, ADMIN_USERS_PAGE_SIZE);
    return { items, total, page, pageSize: ADMIN_USERS_PAGE_SIZE };
  }

  async function create(input: AdminUserCreateInput, actorId: string, ip: string | null): Promise<AdminUserRow> {
    const passwordHash = await deps.hashPassword(input.password);
    return deps.repo.create({ name: input.name, email: input.email, role: input.role, passwordHash }, (id) => ({
      adminId: actorId,
      action: 'ADMIN_USER_CREATED',
      entity: ENTITY,
      entityId: id,
      metadata: { role: input.role },
      ip,
    }));
  }

  async function update(id: string, input: AdminUserUpdateInput, actorId: string, ip: string | null): Promise<AdminUserRow> {
    const target = await deps.repo.findById(id);
    if (!target) throw notFound('Admin user not found');
    if (id === actorId && input.active === false) throw conflict('You cannot deactivate your own account.');

    const data: AdminUserChanges = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.role !== undefined) data.role = input.role;
    if (input.active !== undefined) data.active = input.active;
    if (input.password !== undefined) {
      data.passwordHash = await deps.hashPassword(input.password);
      data.failedLoginCount = 0;
      data.lockedUntil = null;
    }

    const losesSuperAdmin =
      target.role === 'SUPER_ADMIN' && target.active && (input.role === 'EVALUATOR' || input.active === false);

    const evict =
      input.password !== undefined ||
      input.active === false ||
      (input.role !== undefined && input.role !== target.role);

    const row = await deps.repo.update(id, data, { keepAnotherSuperAdmin: losesSuperAdmin }, {
      adminId: actorId,
      action: 'ADMIN_USER_UPDATED',
      entity: ENTITY,
      entityId: id,
      metadata: {
        fields: Object.keys(input).filter((k) => input[k as keyof AdminUserUpdateInput] !== undefined),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        passwordReset: input.password !== undefined,
      },
      ip,
    });
    if (evict) await deps.revokeSessions(id);
    return row;
  }

  return { list, create, update };
}

export type AdminUsersService = ReturnType<typeof createAdminUsersService>;
