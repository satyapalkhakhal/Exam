// modules/candidateAuth/candidateAuth.controller.ts
// Thin HTTP layer: tokens only ever travel in httpOnly cookies. The candidate
// id always comes from req.candidate (the verified token), never from the URL.

import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../../shared/errors.js';
import { ok } from '../../shared/http.js';
import { clientInfo } from '../../shared/utils/clientInfo.js';
import { COOKIES, clearAuthCookies, setAuthCookies, shouldClearCookiesAfterRefreshError } from '../adminAuth/tokens.js';
import type { CandidateAuthService, CandidateSignedIn } from './candidateAuth.service.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const refreshCookie = (req: Request): string | undefined => {
  const v: unknown = req.cookies?.[COOKIES.candidate.refresh];
  return typeof v === 'string' && v !== '' ? v : undefined;
};

const authed = (req: Request) => {
  if (!req.candidate) throw unauthorized();
  return req.candidate;
};

function respondSignedIn(res: Response, s: CandidateSignedIn) {
  setAuthCookies(res, 'candidate', { access: s.accessToken, refresh: s.refreshToken });
  return ok(res, { candidate: s.candidate });
}

export function createCandidateAuthController(service: CandidateAuthService) {
  return {
    requestOtp: wrap(async (req, res) =>
      ok(res, await service.requestOtp({ identifier: req.body.identifier, client: clientInfo(req) })),
    ),
    verifyOtp: wrap(async (req, res) =>
      respondSignedIn(res, await service.verifyOtp({ ...req.body, client: clientInfo(req) })),
    ),
    requestMobileLink: wrap(async (req, res) =>
      ok(res, await service.requestMobileLink({ ...req.body, client: clientInfo(req) })),
    ),
    verifyMobileLink: wrap(async (req, res) =>
      respondSignedIn(res, await service.verifyMobileLink({ ...req.body, client: clientInfo(req) })),
    ),
    refresh: wrap(async (req, res) => {
      try {
        return respondSignedIn(res, await service.refresh(refreshCookie(req)));
      } catch (err) {
        if (shouldClearCookiesAfterRefreshError(err)) clearAuthCookies(res, 'candidate');
        throw err;
      }
    }),
    logout: wrap(async (req, res) => {
      await service.logout(refreshCookie(req));
      clearAuthCookies(res, 'candidate');
      return ok(res, { loggedOut: true });
    }),
    me: wrap(async (req, res) => {
      const c = authed(req);
      return ok(res, await service.me(c.id, c.sessionFamily));
    }),
    location: wrap(async (req, res) => ok(res, await service.recordLocation(authed(req), req.body, clientInfo(req)))),
    exams: wrap(async (req, res) => ok(res, await service.exams(authed(req).id))),
  };
}
