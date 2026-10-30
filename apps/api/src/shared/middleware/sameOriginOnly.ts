// shared/middleware/sameOriginOnly.ts
// CSRF defence in depth for endpoints that accept a text/plain body or a
// refresh cookie (the exam unload beacon and events). SameSite=Strict cookies
// already stop cross-site sends; this also refuses a request whose browser
// says it is not same-origin (Sec-Fetch-Site) or whose Origin is not the web
// app (PUBLIC_WEB_URL). Missing headers are allowed: non-browser clients and
// older browsers send neither, and they cannot carry the victim's cookies.

import type { NextFunction, Request, Response } from 'express';
import { env } from '../../infrastructure/config/env.js';
import { forbidden } from '../errors.js';

const webOrigin = (() => {
  try {
    return new URL(env.PUBLIC_WEB_URL).origin;
  } catch {
    return env.PUBLIC_WEB_URL;
  }
})();

export function sameOriginOnly(req: Request, _res: Response, next: NextFunction): void {
  const site = req.get('sec-fetch-site');
  const origin = req.get('origin');
  if ((site !== undefined && site !== 'same-origin') || (origin !== undefined && origin !== webOrigin)) {
    next(forbidden('Cross-site request refused.'));
    return;
  }
  next();
}
