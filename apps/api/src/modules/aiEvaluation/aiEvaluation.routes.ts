// modules/aiEvaluation/aiEvaluation.routes.ts
// /admin/ai-evaluations. Super Admin only: router.ts mounts this behind
// authenticateAdmin + authorize('SUPER_ADMIN').

import { Router } from 'express';
import { validate } from '../../shared/middleware/validate.js';
import { createAiEvaluationController } from './aiEvaluation.controller.js';
import type { AiEvaluationService } from './aiEvaluation.service.js';
import { AiRunIdParamsSchema, AiRunListQuerySchema, AiRunStartSchema } from './aiEvaluation.schemas.js';

export function createAiEvaluationRouter(service: AiEvaluationService): Router {
  const c = createAiEvaluationController(service);
  const r = Router();
  r.post('/', validate({ body: AiRunStartSchema }), c.start);
  r.get('/', validate({ query: AiRunListQuerySchema }), c.list);
  r.post('/:runId/cancel', validate({ params: AiRunIdParamsSchema }), c.cancel);
  return r;
}
