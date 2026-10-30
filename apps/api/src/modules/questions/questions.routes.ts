// modules/questions/questions.routes.ts
// Two routers, both mounted behind authenticateAdmin in router.ts: /admin/questions
// (reads open to any admin so Evaluators see guidance; writes Super Admin) and the
// role-scoped /admin/roles/:id/questions/* (order, unlock; Super Admin).

import { Router } from 'express';
import { authorize } from '../../shared/middleware/authorize.js';
import { adminUploadLimiter } from '../../shared/middleware/rateLimit.js';
import { uploadSpreadsheet } from '../../shared/middleware/upload.js';
import { validate } from '../../shared/middleware/validate.js';
import { createQuestionsController } from './questions.controller.js';
import type { QuestionsService } from './questions.service.js';
import {
  IdParamsSchema,
  ImportConfirmSchema,
  ImportPreviewBodySchema,
  QuestionActiveSchema,
  QuestionCreateSchema,
  QuestionListQuerySchema,
  QuestionOrderSchema,
  QuestionUnlockSchema,
  QuestionUpdateSchema,
} from './questions.schemas.js';

const superAdmin = authorize('SUPER_ADMIN');

export function createQuestionsRouter(service: QuestionsService): Router {
  const c = createQuestionsController(service);
  const r = Router();
  r.get('/', validate({ query: QuestionListQuerySchema }), c.list);
  r.get('/template.csv', superAdmin, c.template);
  r.get('/sample.csv', superAdmin, c.sample);
  r.post('/', superAdmin, validate({ body: QuestionCreateSchema }), c.create);
  r.post(
    '/import/preview',
    superAdmin,
    adminUploadLimiter,
    uploadSpreadsheet('file'),
    validate({ body: ImportPreviewBodySchema }),
    c.preview,
  );
  r.post('/import/confirm', superAdmin, validate({ body: ImportConfirmSchema }), c.confirm);
  r.patch('/:id', superAdmin, validate({ params: IdParamsSchema, body: QuestionUpdateSchema }), c.update);
  r.patch('/:id/active', superAdmin, validate({ params: IdParamsSchema, body: QuestionActiveSchema }), c.setActive);
  return r;
}

export function createRoleQuestionsRouter(service: QuestionsService): Router {
  const c = createQuestionsController(service);
  const r = Router();
  r.patch('/:id/questions/order', superAdmin, validate({ params: IdParamsSchema, body: QuestionOrderSchema }), c.reorder);
  r.post('/:id/questions/unlock', superAdmin, validate({ params: IdParamsSchema, body: QuestionUnlockSchema }), c.unlock);
  return r;
}
