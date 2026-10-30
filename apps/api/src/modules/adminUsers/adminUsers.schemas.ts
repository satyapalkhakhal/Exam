// modules/adminUsers/adminUsers.schemas.ts
// Request schemas live in @exam/shared so the web forms validate identically.
import { z } from 'zod';
export { AdminUserCreateSchema, AdminUserUpdateSchema, PageQuerySchema } from '@exam/shared';

export const AdminUserIdParamsSchema = z.object({ id: z.string().uuid() });
