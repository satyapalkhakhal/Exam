// modules/candidates/candidates.routes.ts
// /admin/candidates, mounted behind authenticateAdmin in router.ts. Every route
// is Super Admin only: evaluators never see candidate identity.

import { Router } from 'express';
import { authorize } from '../../shared/middleware/authorize.js';
import { adminUploadLimiter } from '../../shared/middleware/rateLimit.js';
import { uploadSpreadsheet } from '../../shared/middleware/upload.js';
import { validate } from '../../shared/middleware/validate.js';
import { createCandidatesController } from './candidates.controller.js';
import type { CandidatesService } from './candidates.service.js';
import {
  CandidateDetailQuerySchema,
  CandidateEligibilitySchema,
  CandidateListQuerySchema,
  CandidateLocationExemptSchema,
  CandidateResetSchema,
  CandidateUpdateSchema,
  IdParamsSchema,
  ImportConfirmSchema,
  ImportPreviewBodySchema,
} from './candidates.schemas.js';

export function createCandidatesRouter(service: CandidatesService): Router {
  const c = createCandidatesController(service);
  const r = Router();
  r.use(authorize('SUPER_ADMIN'));
  r.get('/', validate({ query: CandidateListQuerySchema }), c.list);
  r.get('/template.csv', c.template);
  r.post('/import/preview', adminUploadLimiter, uploadSpreadsheet('file'), validate({ body: ImportPreviewBodySchema }), c.preview);
  r.post('/import/confirm', validate({ body: ImportConfirmSchema }), c.confirm);
  r.get('/:id', validate({ params: IdParamsSchema, query: CandidateDetailQuerySchema }), c.detail);
  r.patch('/:id', validate({ params: IdParamsSchema, body: CandidateUpdateSchema }), c.update);
  r.patch('/:id/eligibility', validate({ params: IdParamsSchema, body: CandidateEligibilitySchema }), c.eligibility);
  r.patch('/:id/location-exempt', validate({ params: IdParamsSchema, body: CandidateLocationExemptSchema }), c.locationExempt);
  r.post('/:id/reset-attempt', validate({ params: IdParamsSchema, body: CandidateResetSchema }), c.reset);
  return r;
}
