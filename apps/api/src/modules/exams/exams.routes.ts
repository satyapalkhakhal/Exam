// modules/exams/exams.routes.ts
// /api/admin/exams. Mounted in router.ts behind authenticateAdmin only: the
// list is open to any admin (submission filters need it), so the Super Admin
// gate is applied per write route here.

import { Router } from 'express';
import { authorize } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';
import { createExamsController } from './exams.controller.js';
import type { ExamsService } from './exams.service.js';
import {
  ExamCreateSchema,
  ExamIdParamsSchema,
  ExamListQuerySchema,
  ExamUpdateSchema,
  RoundCreateSchema,
  RoundIdParamsSchema,
  RoundSettingsSchema,
} from './exams.schemas.js';

export function createExamsRouter(service: ExamsService): Router {
  const c = createExamsController(service);
  const superAdmin = authorize('SUPER_ADMIN');
  const r = Router();
  r.get('/', validate({ query: ExamListQuerySchema }), c.list);
  r.post('/', superAdmin, validate({ body: ExamCreateSchema }), c.create);
  r.patch('/:id', superAdmin, validate({ params: ExamIdParamsSchema, body: ExamUpdateSchema }), c.update);
  r.post('/:id/rounds', superAdmin, validate({ params: ExamIdParamsSchema, body: RoundCreateSchema }), c.addRound);
  r.put(
    '/rounds/:roundId/settings',
    superAdmin,
    validate({ params: RoundIdParamsSchema, body: RoundSettingsSchema }),
    c.updateRoundSettings,
  );
  return r;
}
