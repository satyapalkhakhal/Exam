// modules/adminAuth/adminAuth.controller.ts
// Thin HTTP layer: tokens only ever travel in httpOnly cookies, never in a
// response body.

import type { NextFunction, Request, Response } from 'express';
import { ok } from '../../shared/http.js';
import { unauthorized } from '../../shared/errors.js';
import { COOKIES, clearAuthCookies, setAuthCookies, shouldClearCookiesAfterRefreshError } from './tokens.js';
import type { AdminAuthService, SignedIn } from './adminAuth.service.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const refreshCookie = (req: Request): string | undefined => {
  const v: unknown = req.cookies?.[COOKIES.admin.refresh];
  return typeof v === 'string' && v !== '' ? v : undefined;
};

const ipOf = (req: Request): string | null => req.ip ?? null;

function respondSignedIn(res: Response, s: SignedIn) {
  setAuthCookies(res, 'admin', { access: s.accessToken, refresh: s.refreshToken });
  return ok(res, { admin: s.admin });
}

export function createAdminAuthController(service: AdminAuthService) {
  return {
    login: wrap(async (req, res) => ok(res, await service.login({ ...req.body, ip: ipOf(req) }))),
    verifyOtp: wrap(async (req, res) => respondSignedIn(res, await service.verifyOtp({ ...req.body, ip: ipOf(req) }))),
    refresh: wrap(async (req, res) => {
      try {
        return respondSignedIn(res, await service.refresh(refreshCookie(req), ipOf(req)));
      } catch (err) {
        if (shouldClearCookiesAfterRefreshError(err)) clearAuthCookies(res, 'admin');
        throw err;
      }
    }),
    logout: wrap(async (req, res) => {
      await service.logout(refreshCookie(req), ipOf(req));
      clearAuthCookies(res, 'admin');
      return ok(res, { loggedOut: true });
    }),
    logoutAll: wrap(async (req, res) => {
      if (!req.admin) throw unauthorized();
      await service.logoutAll(req.admin.id, ipOf(req));
      clearAuthCookies(res, 'admin');
      return ok(res, { loggedOut: true });
    }),
    me: wrap(async (req, res) => {
      if (!req.admin) throw unauthorized();
      return ok(res, await service.me(req.admin.id));
    }),
  };
}
