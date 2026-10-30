import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { getRedis, setRedisClient } from '../src/infrastructure/redis/redis.js';
import { sha256 } from '../src/shared/utils/hash.js';
import { issueRefreshToken } from '../src/modules/adminAuth/tokens.js';
import { AppError } from '../src/shared/errors.js';
import {
  createAdminAuthService,
  type AdminAuthDeps,
  type AdminAuthRecord,
  type AdminAuthRepository,
} from '../src/modules/adminAuth/adminAuth.service.js';
import type { AuditRecord } from '../src/modules/audit/audit.service.js';

const PASSWORD = 'correct-horse-1';
const NOW = new Date('2026-10-31T10:00:00Z');
const hash = bcrypt.hashSync(PASSWORD, 4);

function fakeRepo(seed: Partial<AdminAuthRecord> = {}) {
  const row: AdminAuthRecord = {
    id: 'a1',
    email: 'admin@arihant.test',
    name: 'Admin',
    role: 'SUPER_ADMIN',
    active: true,
    passwordHash: hash,
    failedLoginCount: 0,
    lockedUntil: null,
    ...seed,
  };
  const repo: AdminAuthRepository = {
    async findByEmail(email) {
      return email === row.email ? { ...row } : null;
    },
    async findById(id) {
      return id === row.id ? { ...row } : null;
    },
    async registerFailure() {
      row.failedLoginCount += 1;
      return row.failedLoginCount;
    },
    async lock(_id, until) {
      row.lockedUntil = until;
      row.failedLoginCount = 0;
    },
    async clearFailures() {
      row.failedLoginCount = 0;
      row.lockedUntil = null;
    },
    async markLoggedIn() {},
  };
  return { row, repo };
}

function setup(seed: Partial<AdminAuthRecord> = {}) {
  const { row, repo } = fakeRepo(seed);
  const audits: AuditRecord[] = [];
  const issued: string[] = [];
  const deps: AdminAuthDeps = {
    repo,
    audit: async (e) => {
      audits.push(e);
    },
    otp: {
      issue: async (p) => {
        issued.push(p.subjectId);
      },
      verify: async () => {},
    },
    challenges: {
      create: async () => 'challenge-1',
      peek: async () => null,
      drop: async () => {},
    },
    now: () => NOW,
  };
  return { row, audits, issued, service: createAdminAuthService(deps) };
}

const login = (s: ReturnType<typeof setup>, password: string, email = 'admin@arihant.test') =>
  s.service.login({ email, password, ip: '10.0.0.1' });

const errOf = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AppError);
    return e;
  }
  assert.fail('expected rejection');
};

test('correct password issues an OTP and returns a challenge', async () => {
  const s = setup();
  const r = await login(s, PASSWORD);
  assert.deepEqual(r, { otpRequired: true, challengeId: 'challenge-1' });
  assert.deepEqual(s.issued, ['a1']);
});

test('the 5th wrong password sets lockedUntil = now + 15 min and throws ACCOUNT_LOCKED', async () => {
  const s = setup();
  for (let i = 0; i < 4; i++) assert.equal((await errOf(login(s, 'wrong'))).code, 'UNAUTHORIZED');
  const e = await errOf(login(s, 'wrong'));
  assert.equal(e.code, 'ACCOUNT_LOCKED');
  assert.equal(s.row.lockedUntil?.getTime(), NOW.getTime() + 15 * 60_000);
  assert.ok(s.audits.some((a) => a.action === 'ADMIN_LOCKED' && a.adminId === 'a1'));
  assert.equal(s.audits.filter((a) => a.action === 'ADMIN_LOGIN_FAILED').length, 4);
});

test('a correct password while locked still throws ACCOUNT_LOCKED and sends no OTP', async () => {
  const s = setup({ lockedUntil: new Date(NOW.getTime() + 60_000) });
  assert.equal((await errOf(login(s, PASSWORD))).code, 'ACCOUNT_LOCKED');
  assert.deepEqual(s.issued, []);
});

test('an expired lock no longer blocks a correct password', async () => {
  const s = setup({ lockedUntil: new Date(NOW.getTime() - 1) });
  await login(s, PASSWORD);
  assert.equal(s.row.lockedUntil, null);
});

test('success resets failedLoginCount', async () => {
  const s = setup();
  await errOf(login(s, 'wrong'));
  await errOf(login(s, 'wrong'));
  assert.equal(s.row.failedLoginCount, 2);
  await login(s, PASSWORD);
  assert.equal(s.row.failedLoginCount, 0);
});

test('a wrong email and a wrong password produce the identical error code and message', async () => {
  const s = setup();
  const badEmail = await errOf(login(s, PASSWORD, 'nobody@arihant.test'));
  const badPassword = await errOf(login(s, 'wrong'));
  assert.equal(badEmail.code, 'UNAUTHORIZED');
  assert.equal(badEmail.statusCode, badPassword.statusCode);
  assert.equal(badEmail.code, badPassword.code);
  assert.equal(badEmail.message, badPassword.message);
});

test('an inactive admin gets the same generic error even with the right password', async () => {
  const s = setup({ active: false });
  const e = await errOf(login(s, PASSWORD));
  assert.equal(e.code, 'UNAUTHORIZED');
  assert.deepEqual(s.issued, []);
});

test('verifyOtp with an unknown challenge -> OTP_EXPIRED', async () => {
  const s = setup();
  const e = await errOf(s.service.verifyOtp({ challengeId: 'nope', code: '123456', ip: null }));
  assert.equal(e.code, 'OTP_EXPIRED');
});

test('refresh-token reuse is audited as ADMIN_REFRESH_REUSE with the admin and ip', async () => {
  setRedisClient(new RedisMock() as unknown as Redis);
  const s = setup();
  const old = await issueRefreshToken('admin', 'a1');
  await s.service.refresh(old, '10.0.0.9');
  // Within the rotation grace a reuse is a second tab: refused but not audited as theft.
  assert.equal((await errOf(s.service.refresh(old, '10.0.0.9'))).code, 'UNAUTHORIZED');
  assert.equal(s.audits.filter((a) => a.action === 'ADMIN_REFRESH_REUSE').length, 0);
  const usedKey = `exam:rt:used:admin:${sha256(old)}`;
  const marker = JSON.parse((await getRedis().get(usedKey))!) as { rotatedAt: number };
  await getRedis().set(usedKey, JSON.stringify({ ...marker, rotatedAt: marker.rotatedAt - 60_000 }));
  assert.equal((await errOf(s.service.refresh(old, '10.0.0.9'))).code, 'UNAUTHORIZED');
  const reuse = s.audits.filter((a) => a.action === 'ADMIN_REFRESH_REUSE');
  assert.equal(reuse.length, 1);
  assert.equal(reuse[0]!.adminId, 'a1');
  assert.equal(reuse[0]!.ip, '10.0.0.9');
});
