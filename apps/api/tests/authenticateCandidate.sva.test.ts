import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { NextFunction, Request, Response } from 'express';
import { setRedisClient } from '../src/infrastructure/redis/redis.js';
import {
  COOKIES,
  issueRefreshToken,
  peekRefreshFamily,
  revokeAllSessions,
  revokeRefreshToken,
  signAccess,
} from '../src/modules/adminAuth/tokens.js';
import { authenticateCandidate } from '../src/shared/middleware/authenticateCandidate.js';

beforeEach(() => {
  setRedisClient(new RedisMock() as unknown as Redis);
});

const tick = () => new Promise((r) => setTimeout(r, 3));

function run(token: string): Promise<{ err: unknown; req: Request }> {
  const req = { cookies: { [COOKIES.candidate.access]: token } } as unknown as Request;
  return new Promise((resolve) => {
    const next: NextFunction = (err?: unknown) => resolve({ err, req });
    authenticateCandidate(async () => true)(req, {} as Response, next);
  });
}

async function login(sub: string) {
  const refresh = await issueRefreshToken('candidate', sub);
  const fam = (await peekRefreshFamily('candidate', refresh))!;
  return { refresh, access: signAccess('candidate', { sub, fam }) };
}

test('authenticateCandidate rejects an access token issued before revokeAllSessions(candidate)', async () => {
  const old = (await login('c1')).access;
  assert.equal((await run(old)).err, undefined);
  await tick();
  await revokeAllSessions('candidate', 'c1');
  await tick();
  const denied = await run(old);
  assert.equal((denied.err as { code?: string }).code, 'UNAUTHORIZED');
  const fresh = await run((await login('c1')).access);
  assert.equal(fresh.err, undefined);
  assert.equal(fresh.req.candidate?.id, 'c1');
});

test('authenticateCandidate: after logout (family revoked) the old access cookie is 401', async () => {
  const s = await login('c2');
  assert.equal((await run(s.access)).err, undefined);
  await revokeRefreshToken('candidate', s.refresh);
  assert.equal(((await run(s.access)).err as { code?: string }).code, 'UNAUTHORIZED');
});

test('authenticateCandidate: a token naming a family that never existed is 401', async () => {
  const forged = signAccess('candidate', { sub: 'c3', fam: 'made-up' });
  assert.equal(((await run(forged)).err as { code?: string }).code, 'UNAUTHORIZED');
});
