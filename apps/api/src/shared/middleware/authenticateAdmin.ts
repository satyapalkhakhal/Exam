// shared/middleware/authenticateAdmin.ts
// Admin routes: verifies the admin access cookie (admin secret + audience, so a
// candidate token is rejected) and then re-reads the admin row, so a
// deactivation or role change takes effect on the very next request instead
// of when the 15 min token expires. A token issued before
// revokeAllSessions('admin', id) (password reset, deactivation, role change,
// logout-all) is refused, and so is one whose login family was revoked
// (logout, refresh-token reuse). Sets req.admin = {id, role}.

import type { NextFunction, Request, Response } from 'express';
import type { AdminRole } from '@exam/shared';
import { adminAuthRepository } from '../../modules/adminAuth/adminAuth.repository.js';
import { COOKIES, assertSessionLive, verifyAccess, type AccessPayload } from '../../modules/adminAuth/tokens.js';
import { unauthorized } from '../errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: { id: string; role: AdminRole };
    }
  }
}

export function authenticateAdmin(req: Request, _res: Response, next: NextFunction): void {
  const token: unknown = req.cookies?.[COOKIES.admin.access];
  if (typeof token !== 'string' || token === '') {
    next(unauthorized());
    return;
  }
  let payload: AccessPayload;
  try {
    payload = verifyAccess('admin', token);
  } catch (err) {
    next(err);
    return;
  }
  assertSessionLive('admin', payload)
    .then(() => adminAuthRepository.findById(payload.sub))
    .then((admin) => {
      if (!admin || !admin.active) throw unauthorized();
      req.admin = { id: admin.id, role: admin.role };
      next();
    })
    .catch(next);
}
