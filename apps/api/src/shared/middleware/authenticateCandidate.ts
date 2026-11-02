// shared/middleware/authenticateCandidate.ts
// Candidate routes (the token subject is a candidate account id): verifies the candidate access cookie (candidate secret +
// audience, so an admin token is rejected), requires the login-session family
// it carries, and re-checks that the account still has an eligible application so a
// deactivation takes effect on the next request. A token issued before
// revokeAllSessions('candidate', id) is refused, and so is one whose login
// family was revoked (logout, refresh-token reuse). Sets
// req.candidate = {id, sessionFamily}; every candidate query is scoped by this
// id, never by anything in the URL.

import type { NextFunction, Request, Response } from 'express';
import { COOKIES, assertSessionLive, verifyAccess } from '../../modules/adminAuth/tokens.js';
import { unauthorized } from '../errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      candidate?: { id: string; sessionFamily: string };
    }
  }
}

export function authenticateCandidate(isActive: (accountId: string) => Promise<boolean>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token: unknown = req.cookies?.[COOKIES.candidate.access];
    if (typeof token !== 'string' || token === '') {
      next(unauthorized());
      return;
    }
    let payload: ReturnType<typeof verifyAccess>;
    try {
      payload = verifyAccess('candidate', token);
    } catch (err) {
      next(err);
      return;
    }
    const family = payload.fam;
    if (!family) {
      next(unauthorized());
      return;
    }
    assertSessionLive('candidate', payload)
      .then(() => isActive(payload.sub))
      .then((active) => {
        if (!active) throw unauthorized();
        req.candidate = { id: payload.sub, sessionFamily: family };
        next();
      })
      .catch(next);
  };
}
