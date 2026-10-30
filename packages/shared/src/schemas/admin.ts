// schemas/admin.ts
// Zod contracts for admin sign-in, admin user management and the audit log
// filter, shared by the API (validation) and the web forms. bcrypt only reads
// the first 72 bytes, so new passwords are capped there.

import { z } from 'zod';
import { AdminRole } from '../enums.js';

const email = z.string().trim().toLowerCase().email().max(254);
const newPassword = z.string().min(8, 'Password must be at least 8 characters').max(72);
const roleEnum = z.enum([AdminRole.SUPER_ADMIN, AdminRole.EVALUATOR]);

export const AdminLoginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});
export type AdminLoginInput = z.infer<typeof AdminLoginSchema>;

export const AdminVerifyOtpSchema = z.object({
  challengeId: z.string().min(1).max(200),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type AdminVerifyOtpInput = z.infer<typeof AdminVerifyOtpSchema>;

export const AdminUserCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email,
  role: roleEnum,
  password: newPassword,
});
export type AdminUserCreateInput = z.infer<typeof AdminUserCreateSchema>;

// `password` here is the Super Admin's reset: it also clears the lockout.
export const AdminUserUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: roleEnum.optional(),
    active: z.boolean().optional(),
    password: newPassword.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type AdminUserUpdateInput = z.infer<typeof AdminUserUpdateSchema>;

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const AuditListQuerySchema = PageQuerySchema.extend({
  entity: z.string().trim().min(1).max(64).optional(),
  adminId: z.string().uuid().optional(),
  from: day.optional(),
  to: day.optional(),
});
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;

export interface AdminPublic {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
