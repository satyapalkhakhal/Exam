import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { setRedisClient, getRedis } from '../src/infrastructure/redis/redis.js';
import {
  signAccess,
  verifyAccess,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllSessions,
  assertAccessCurrent,
  isRefreshFamilyLive,
  peekRefreshFamily,
  ROTATION_GRACE_MS,
  RefreshRaceError,
  shouldClearCookiesAfterRefreshError,
} from '../src/modules/adminAuth/tokens.js';
import { AppError } from '../src/shared/errors.js';

/** A clock past the rotation grace, so a reuse counts as theft rather than a tab race. */
const later = { now: () => Date.now() + ROTATION_GRACE_MS + 1_000 };

const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code;
const isUnauthorized = (e: unknown) => codeOf(e) === 'UNAUTHORIZED';

beforeEach(async () => {
  setRedisClient(new RedisMock() as unknown as Redis);
  await getRedis().flushall();
});

test('an admin access token verifies as admin and carries sub + role', () => {
  const t = signAccess('admin', { sub: 'a1', role: 'SUPER_ADMIN' });
  const p = verifyAccess('admin', t);
  assert.equal(p.sub, 'a1');
  assert.equal(p.role, 'SUPER_ADMIN');
});

test('a candidate token fails verifyAccess(admin), and vice versa', () => {
  const cand = signAccess('candidate', { sub: 'c1' });
  assert.throws(() => verifyAccess('admin', cand), isUnauthorized);
  const admin = signAccess('admin', { sub: 'a1', role: 'SUPER_ADMIN' });
  assert.throws(() => verifyAccess('candidate', admin), isUnauthorized);
});

test('garbage access token -> UNAUTHORIZED', () => {
  assert.throws(() => verifyAccess('admin', 'not.a.jwt'), isUnauthorized);
});

test('refresh token is stored only as a hash under exam:rt:{kind}: with the kind TTL', async () => {
  const token = await issueRefreshToken('admin', 'a1');
  const keys = await getRedis().keys('exam:rt:admin:*');
  assert.equal(keys.length, 1);
  assert.ok(!keys[0]!.includes(token));
  const ttl = await getRedis().ttl(keys[0]!);
  assert.ok(ttl > 7 * 86400 - 10 && ttl <= 7 * 86400);
  await issueRefreshToken('candidate', 'c1');
  const cKey = (await getRedis().keys('exam:rt:candidate:*'))[0]!;
  assert.ok((await getRedis().ttl(cKey)) <= 12 * 3600);
});

test('rotation returns a new token for the same subject, and the old one then fails', async () => {
  const old = await issueRefreshToken('admin', 'a1');
  const next = await rotateRefreshToken('admin', old);
  assert.equal(next.subjectId, 'a1');
  assert.notEqual(next.token, old);
  await assert.rejects(rotateRefreshToken('admin', old), isUnauthorized);
});

test('reusing a rotated token revokes the whole family, including the new token', async () => {
  const old = await issueRefreshToken('admin', 'a1');
  const next = await rotateRefreshToken('admin', old);
  await assert.rejects(rotateRefreshToken('admin', old, later), isUnauthorized);
  await assert.rejects(rotateRefreshToken('admin', next.token), isUnauthorized);
});

test('reuse revokes only that family; another session of the same subject survives', async () => {
  const a = await issueRefreshToken('admin', 'a1');
  const b = await issueRefreshToken('admin', 'a1');
  await rotateRefreshToken('admin', a);
  await assert.rejects(rotateRefreshToken('admin', a, later), isUnauthorized);
  const bNext = await rotateRefreshToken('admin', b);
  assert.equal(bNext.subjectId, 'a1');
});

test('a token of one kind cannot be rotated as the other kind', async () => {
  const t = await issueRefreshToken('candidate', 'c1');
  await assert.rejects(rotateRefreshToken('admin', t), isUnauthorized);
});

test('revoke (logout) kills the family and returns the subject', async () => {
  const t = await issueRefreshToken('admin', 'a1');
  const next = await rotateRefreshToken('admin', t);
  assert.equal(await revokeRefreshToken('admin', next.token), 'a1');
  await assert.rejects(rotateRefreshToken('admin', next.token), isUnauthorized);
  assert.equal(await revokeRefreshToken('admin', 'unknown'), null);
});

test('access tokens round-trip an optional family; refresh family is readable and stable across rotation', async () => {
  const p = verifyAccess('candidate', signAccess('candidate', { sub: 'c9', fam: 'fam-1' }));
  assert.equal(p.fam, 'fam-1');
  assert.equal(verifyAccess('candidate', signAccess('candidate', { sub: 'c9' })).fam, undefined);

  const { peekRefreshFamily } = await import('../src/modules/adminAuth/tokens.js');
  const t1 = await issueRefreshToken('candidate', 'c9');
  const fam = await peekRefreshFamily('candidate', t1);
  assert.ok(fam);
  const { token: t2 } = await rotateRefreshToken('candidate', t1);
  assert.equal(await peekRefreshFamily('candidate', t2), fam);
  assert.equal(await peekRefreshFamily('candidate', t1), null);
});

const tick = () => new Promise((r) => setTimeout(r, 3));

test('revokeAllSessions: refresh tokens from before it fail (and are deleted); a later login works', async () => {
  const before1 = await issueRefreshToken('admin', 'a1');
  const rotated = await rotateRefreshToken('admin', before1);
  const other = await issueRefreshToken('admin', 'a2');
  await tick();
  await revokeAllSessions('admin', 'a1');
  await tick();
  await assert.rejects(rotateRefreshToken('admin', rotated.token), isUnauthorized);
  assert.equal((await getRedis().keys('exam:rt:admin:*')).length, 1, 'only a2 token left');
  const after = await issueRefreshToken('admin', 'a1');
  assert.equal((await rotateRefreshToken('admin', after)).subjectId, 'a1');
  assert.equal((await rotateRefreshToken('admin', other)).subjectId, 'a2');
  const ttl = await getRedis().ttl('exam:sva:admin:a1');
  assert.ok(ttl > 0);
});

test('assertAccessCurrent: an access token issued before revokeAllSessions -> UNAUTHORIZED; after -> ok', async () => {
  const old = verifyAccess('admin', signAccess('admin', { sub: 'a1', role: 'SUPER_ADMIN' }));
  await assertAccessCurrent('admin', old);
  await tick();
  await revokeAllSessions('admin', 'a1');
  await tick();
  await assert.rejects(assertAccessCurrent('admin', old), isUnauthorized);
  const fresh = verifyAccess('admin', signAccess('admin', { sub: 'a1', role: 'SUPER_ADMIN' }));
  await assertAccessCurrent('admin', fresh);
  // another subject is untouched
  await assertAccessCurrent('admin', verifyAccess('admin', signAccess('admin', { sub: 'a2' })));
});

test('reuse of a rotated token reports the subject to onReuse', async () => {
  const seen: string[] = [];
  const onReuse = async (subjectId: string) => {
    seen.push(subjectId);
  };
  const old = await issueRefreshToken('admin', 'a1');
  await rotateRefreshToken('admin', old, { onReuse });
  assert.deepEqual(seen, []);
  await assert.rejects(rotateRefreshToken('admin', old, { onReuse, ...later }), isUnauthorized);
  assert.deepEqual(seen, ['a1']);
});

test('isRefreshFamilyLive: true while the login lives (across rotation), false after logout or reuse', async () => {
  const t = await issueRefreshToken('admin', 'a1');
  const fam = (await peekRefreshFamily('admin', t))!;
  assert.equal(await isRefreshFamilyLive('admin', fam), true);
  const next = await rotateRefreshToken('admin', t);
  assert.equal(next.family, fam);
  assert.equal(await isRefreshFamilyLive('admin', fam), true);
  await revokeRefreshToken('admin', next.token);
  assert.equal(await isRefreshFamilyLive('admin', fam), false);
  assert.equal(await isRefreshFamilyLive('candidate', fam), false);
});

test('I3: a reuse within the rotation grace (a second tab) is refused without revoking the login', async () => {
  const seen: string[] = [];
  const onReuse = async (subjectId: string) => {
    seen.push(subjectId);
  };
  const old = await issueRefreshToken('candidate', 'c1');
  const fam = (await peekRefreshFamily('candidate', old))!;
  const next = await rotateRefreshToken('candidate', old);
  await assert.rejects(rotateRefreshToken('candidate', old, { onReuse }), (e: unknown) => e instanceof RefreshRaceError);
  assert.deepEqual(seen, []);
  assert.equal(await isRefreshFamilyLive('candidate', fam), true);
  const again = await rotateRefreshToken('candidate', next.token);
  assert.equal(again.subjectId, 'c1');
});

test('I3: the same reuse after the grace is still theft: the family is revoked', async () => {
  const old = await issueRefreshToken('candidate', 'c1');
  const fam = (await peekRefreshFamily('candidate', old))!;
  await rotateRefreshToken('candidate', old);
  await assert.rejects(rotateRefreshToken('candidate', old, later), (e: unknown) => isUnauthorized(e) && !(e instanceof RefreshRaceError));
  assert.equal(await isRefreshFamilyLive('candidate', fam), false);
});

test('I2: refresh cookies are cleared only for a genuine 401, never a 5xx or a tab race', () => {
  assert.equal(shouldClearCookiesAfterRefreshError(new AppError(401, 'UNAUTHORIZED', 'x')), true);
  assert.equal(shouldClearCookiesAfterRefreshError(new RefreshRaceError()), false);
  assert.equal(shouldClearCookiesAfterRefreshError(new AppError(500, 'INTERNAL_ERROR', 'x')), false);
  assert.equal(shouldClearCookiesAfterRefreshError(new Error('ECONNRESET')), false);
});
