// shared/middleware/resolveApplication.ts
// Exam routes name an application (:applicationId) in the URL, but the URL is
// never trusted: this resolves it to an eligible application owned by the
// token's account (req.candidate.id) and answers 404 for anything else, so a
// candidate cannot probe or touch another person's application. Runs after
// the params are validated as a UUID and after authentication.

import type { NextFunction, Request, Response } from 'express';
import { notFound, unauthorized } from '../errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by resolveApplication: an eligible application of req.candidate's account. */
      applicationId?: string;
    }
  }
}

export function resolveApplication(owns: (accountId: string, applicationId: string) => Promise<boolean>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const account = req.candidate;
    if (!account) {
      next(unauthorized());
      return;
    }
    const applicationId = String(req.params.applicationId);
    owns(account.id, applicationId)
      .then((ok) => {
        if (!ok) throw notFound('Exam not found.');
        req.applicationId = applicationId;
        next();
      })
      .catch(next);
  };
}
