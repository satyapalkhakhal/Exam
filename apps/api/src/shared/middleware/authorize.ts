// shared/middleware/authorize.ts
// Role gate for admin routes; must follow authenticateAdmin. A denial is a 403
// and is written to the audit log (PERMISSION_DENIED) so probing is visible; a
// failure to write that audit row never turns the 403 into a 500.

import type { NextFunction, Request, Response } from 'express';
import type { AdminRole } from '@exam/shared';
import { logger } from '../../infrastructure/logger/logger.js';
import { audit } from '../../modules/audit/index.js';
import { forbidden, unauthorized } from '../errors.js';

export function authorize(...roles: AdminRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const admin = req.admin;
    if (!admin) {
      next(unauthorized());
      return;
    }
    if (roles.includes(admin.role)) {
      next();
      return;
    }
    audit
      .record({
        adminId: admin.id,
        action: 'PERMISSION_DENIED',
        entity: 'route',
        entityId: `${req.method} ${req.baseUrl}${req.path}`,
        metadata: { role: admin.role, required: roles },
        ip: req.ip ?? null,
      })
      .catch((err: unknown) => {
        logger.error('audit write failed', { requestId: req.id, message: err instanceof Error ? err.message : 'unknown' });
      })
      .finally(() => next(forbidden()));
  };
}
