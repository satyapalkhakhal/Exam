// modules/jobRoles/jobRoles.routes.ts
// /api/admin/roles. Mounted in router.ts behind authenticateAdmin only: reads
// are open to any admin, so the Super Admin gate is applied per write route here.

import { Router } from 'express';
import { authorize } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';
import { createJobRolesController } from './jobRoles.controller.js';
import type { JobRolesService } from './jobRoles.service.js';
import {
  ExamSettingsUpdateSchema,
  JobRoleCreateSchema,
  JobRoleIdParamsSchema,
  JobRoleUpdateSchema,
} from './jobRoles.schemas.js';

export function createJobRolesRouter(service: JobRolesService): Router {
  const c = createJobRolesController(service);
  const superAdmin = authorize('SUPER_ADMIN');
  const r = Router();
  r.get('/', c.list);
  r.post('/', superAdmin, validate({ body: JobRoleCreateSchema }), c.create);
  r.patch('/:id', superAdmin, validate({ params: JobRoleIdParamsSchema, body: JobRoleUpdateSchema }), c.update);
  r.put(
    '/:id/settings',
    superAdmin,
    validate({ params: JobRoleIdParamsSchema, body: ExamSettingsUpdateSchema }),
    c.updateSettings,
  );
  return r;
}
