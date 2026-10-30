// modules/adminUsers/adminUsers.routes.ts
// /api/admin/users. Mounted in router.ts behind authenticateAdmin +
// authorize('SUPER_ADMIN'), so this file holds no auth.

import { Router } from 'express';
import { validate } from '../../shared/middleware/validate.js';
import { createAdminUsersController } from './adminUsers.controller.js';
import type { AdminUsersService } from './adminUsers.service.js';
import {
  AdminUserCreateSchema,
  AdminUserIdParamsSchema,
  AdminUserUpdateSchema,
  PageQuerySchema,
} from './adminUsers.schemas.js';

export function createAdminUsersRouter(service: AdminUsersService): Router {
  const c = createAdminUsersController(service);
  const r = Router();
  r.get('/', validate({ query: PageQuerySchema }), c.list);
  r.post('/', validate({ body: AdminUserCreateSchema }), c.create);
  r.patch('/:id', validate({ params: AdminUserIdParamsSchema, body: AdminUserUpdateSchema }), c.update);
  return r;
}
