// modules/evaluation/evaluation.routes.ts
// /admin/submissions, mounted behind authenticateAdmin in router.ts. Evaluators
// and Super Admins mark; only a Super Admin reopens a submitted evaluation.

import { Router } from 'express';
import { authorize } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';
import { createEvaluationController } from './evaluation.controller.js';
import type { EvaluationService } from './evaluation.service.js';
import { AiAcceptSchema, AttemptIdParamsSchema, EvaluationSaveSchema, ReopenSchema, SubmissionListQuerySchema } from './evaluation.schemas.js';

export function createEvaluationRouter(service: EvaluationService): Router {
  const c = createEvaluationController(service);
  const r = Router();
  const params = validate({ params: AttemptIdParamsSchema });
  r.use(authorize('SUPER_ADMIN', 'EVALUATOR'));
  r.get('/', validate({ query: SubmissionListQuerySchema }), c.list);
  r.post('/ai/accept', authorize('SUPER_ADMIN'), validate({ body: AiAcceptSchema }), c.acceptAi);
  r.get('/:attemptId', params, c.marking);
  r.post('/:attemptId/lock', params, c.lock);
  r.delete('/:attemptId/lock', params, c.unlock);
  r.put('/:attemptId/evaluation', validate({ params: AttemptIdParamsSchema, body: EvaluationSaveSchema }), c.save);
  r.post('/:attemptId/reopen', authorize('SUPER_ADMIN'), validate({ params: AttemptIdParamsSchema, body: ReopenSchema }), c.reopen);
  return r;
}
