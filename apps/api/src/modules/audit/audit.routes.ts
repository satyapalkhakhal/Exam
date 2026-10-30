// modules/audit/audit.routes.ts
// GET /api/admin/audit (list with filters). Mounted in router.ts behind
// authenticateAdmin + authorize('SUPER_ADMIN'), so this file holds no auth.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { AuditListQuerySchema, type AuditListQuery } from '@exam/shared';
import { ok } from '../../shared/http.js';
import { validate } from '../../shared/middleware/validate.js';
import type { AuditService } from './audit.service.js';

export function createAuditRouter(service: AuditService): Router {
  const r = Router();
  r.get('/', validate({ query: AuditListQuerySchema }), (req: Request, res: Response, next: NextFunction) => {
    service
      .list(req.query as unknown as AuditListQuery)
      .then((data) => ok(res, data))
      .catch(next);
  });
  return r;
}
