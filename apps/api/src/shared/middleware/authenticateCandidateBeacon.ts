// shared/middleware/authenticateCandidateBeacon.ts
// For the two unload endpoints only (answer beacon, activity events): the
// normal access-cookie check, or, when the access cookie is missing or has
// expired, the candidate refresh cookie. A refresh token is accepted only if it
// is live and not yet rotated (peekRefreshFamily), its login family is still
// live, the family was bound to an account by an authenticated exam request
// (resolveFamily), no revokeAllSessions happened after that binding, and the
// candidate is still eligible. Nothing is rotated or re-issued here, so this
// never interferes with the client's own refresh flow. Sets req.candidate just
// like authenticateCandidate; the handlers still scope every write by it.

import type { NextFunction, Request, Response } from 'express';
import {
  COOKIES,
  assertSessionLive,
  getSessionsValidAfter,
  isRefreshFamilyLive,
  peekRefreshFamily,
  verifyAccess,
} from '../../modules/adminAuth/tokens.js';
import { unauthorized } from '../errors.js';

export interface BeaconAuthDeps {
  isActive: (accountId: string) => Promise<boolean>;
  resolveFamily: (family: string) => Promise<{ accountId: string; at: number } | null>;
}

const cookie = (req: Request, name: string): string | undefined => {
  const v: unknown = req.cookies?.[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
};

async function fromAccess(token: string): Promise<{ id: string; sessionFamily: string } | null> {
  try {
    const payload = verifyAccess('candidate', token);
    if (!payload.fam) return null;
    await assertSessionLive('candidate', payload);
    return { id: payload.sub, sessionFamily: payload.fam };
  } catch {
    return null;
  }
}

async function fromRefresh(token: string, deps: BeaconAuthDeps): Promise<{ id: string; sessionFamily: string } | null> {
  const family = await peekRefreshFamily('candidate', token);
  if (!family || !(await isRefreshFamilyLive('candidate', family))) return null;
  const binding = await deps.resolveFamily(family);
  if (!binding) return null;
  const sva = await getSessionsValidAfter('candidate', binding.accountId);
  if (sva !== null && sva >= binding.at) return null;
  return { id: binding.accountId, sessionFamily: family };
}

export function authenticateCandidateBeacon(deps: BeaconAuthDeps) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const run = async () => {
      const access = cookie(req, COOKIES.candidate.access);
      const refresh = cookie(req, COOKIES.candidate.refresh);
      const who = (access ? await fromAccess(access) : null) ?? (refresh ? await fromRefresh(refresh, deps) : null);
      if (!who || !(await deps.isActive(who.id))) throw unauthorized();
      req.candidate = who;
    };
    run().then(() => next(), next);
  };
}
