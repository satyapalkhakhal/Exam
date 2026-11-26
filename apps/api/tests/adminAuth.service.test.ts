import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { getRedis, setRedisClient } from '../src/infrastructure/redis/redis.js';
import { sha256 } from '../src/shared/utils/hash.js';
import { issueRefreshToken } from '../src/modules/adminAuth/tokens.js';
import { AppError } from '../src/shared/errors.js';
import { redisResetTokenStore } from '../src/modules/adminAuth/passwordResets.js';
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
    mobile: null,
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
    async setPassword(_id, expectedHash, passwordHash) {
      if (row.passwordHash !== expectedHash) return false;
      row.passwordHash = passwordHash;
      row.failedLoginCount = 0;
      row.lockedUntil = null;
      return true;
    },
  };
  return { row, repo };
}

type SentEmail = { to: string; subject: string; html: string; text: string };

function setup(seed: Partial<AdminAuthRecord> = {}) {
  const { row, repo } = fakeRepo(seed);
  const sent: SentEmail[] = [];
  const mail = { fail: false };
  /** Runs while the new password is being hashed: between the link check and the write. */
  const hooks: { duringHash?: () => void } = {};
  const audits: AuditRecord[] = [];
  const issued: string[] = [];
  const recipients: Array<{ email: string; mobile: string | null }> = [];
  const deps: AdminAuthDeps = {
    repo,
    audit: async (e) => {
      audits.push(e);
    },
    otp: {
      issue: async (p) => {
        issued.push(p.subjectId);
        recipients.push(p.recipient);
      },
      verify: async () => {},
    },
    challenges: {
      create: async () => 'challenge-1',
      peek: async () => null,
      drop: async () => {},
    },
    resets: redisResetTokenStore,
    hashPassword: async (plain) => {
      hooks.duringHash?.();
      return bcrypt.hash(plain, 4);
    },
    sendEmail: async (m) => {
      if (mail.fail) throw new Error('provider down');
      sent.push(m);
    },
    webUrl: 'https://exam.test/some/path',
    now: () => NOW,
  };
  return { row, audits, issued, recipients, sent, mail, hooks, service: createAdminAuthService(deps) };
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

test('the login code goes to the email and, when one is on file, the mobile', async () => {
  const withMobile = setup({ mobile: '9876543210' });
  await login(withMobile, PASSWORD);
  assert.deepEqual(withMobile.recipients, [{ email: 'admin@arihant.test', mobile: '9876543210' }]);

  const emailOnly = setup();
  await login(emailOnly, PASSWORD);
  assert.deepEqual(emailOnly.recipients, [{ email: 'admin@arihant.test', mobile: null }]);
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

// ---- forgot password (2026-11-26) ------------------------------------------------

const LINK = /https:\/\/exam\.test\/admin\/reset-password#token=([\w-]{43})/;
const tokenFrom = (m: SentEmail | undefined): string => {
  const hit = m && LINK.exec(m.text);
  assert.ok(hit, 'reset link in the email text');
  return hit[1]!;
};
const fresh = async (seed: Partial<AdminAuthRecord> = {}) => {
  setRedisClient(new RedisMock() as unknown as Redis);
  await getRedis().flushall();
  return setup(seed);
};
const request = (s: ReturnType<typeof setup>, email = 'admin@arihant.test') =>
  s.service.requestPasswordReset({ email, ip: '10.0.0.1' });

test('reset request: an active admin gets one email with an origin-based fragment link, audited without the token', async () => {
  const s = await fresh();
  await request(s);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0]!.to, 'admin@arihant.test');
  assert.equal(s.sent[0]!.subject, 'Reset your Arihant Plus admin password');
  assert.ok(s.sent[0]!.html.includes(`#token=${tokenFrom(s.sent[0])}`));
  const a = s.audits.find((x) => x.action === 'ADMIN_PASSWORD_RESET_REQUESTED');
  assert.ok(a);
  assert.equal(a.adminId, 'a1');
  assert.ok(!JSON.stringify(a).includes('#token='));
});

test('reset request: unknown email and inactive admin send nothing and do not throw', async () => {
  const s = await fresh();
  await request(s, 'nobody@arihant.test');
  const inactive = await fresh({ active: false });
  await request(inactive);
  assert.equal(s.sent.length + inactive.sent.length, 0);
});

test('reset request: a locked admin still gets a link', async () => {
  const s = await fresh({ lockedUntil: new Date(NOW.getTime() + 60_000) });
  await request(s);
  assert.equal(s.sent.length, 1);
});

test('reset request: a second request inside the cooldown sends nothing', async () => {
  const s = await fresh();
  await request(s);
  await request(s);
  assert.equal(s.sent.length, 1);
});

test('reset request: a failing email provider does not throw', async () => {
  const s = await fresh();
  s.mail.fail = true;
  await request(s);
  assert.equal(s.sent.length, 0);
});

test('reset: sets the new hash, clears lock and failures, revokes sessions, audits, sends a notice', async () => {
  const s = await fresh({ lockedUntil: new Date(NOW.getTime() + 60_000), failedLoginCount: 3 });
  const session = await issueRefreshToken('admin', 'a1');
  await request(s);
  await s.service.resetPassword({ token: tokenFrom(s.sent[0]), password: 'brand-new-pass', ip: '10.0.0.2' });
  assert.ok(await bcrypt.compare('brand-new-pass', s.row.passwordHash));
  assert.equal(s.row.lockedUntil, null);
  assert.equal(s.row.failedLoginCount, 0);
  assert.equal((await errOf(s.service.refresh(session, null))).code, 'UNAUTHORIZED');
  const a = s.audits.find((x) => x.action === 'ADMIN_PASSWORD_RESET');
  assert.ok(a);
  assert.equal(a.adminId, 'a1');
  assert.ok(!JSON.stringify(a).includes('brand-new-pass'));
  assert.equal(s.sent.at(-1)!.subject, 'Your Arihant Plus admin password was changed');
});

test('reset: the same link twice → RESET_LINK_INVALID (400)', async () => {
  const s = await fresh();
  await request(s);
  const token = tokenFrom(s.sent[0]);
  await s.service.resetPassword({ token, password: 'brand-new-pass', ip: null });
  const e = await errOf(s.service.resetPassword({ token, password: 'another-pass-1', ip: null }));
  assert.equal(e.code, 'RESET_LINK_INVALID');
  assert.equal(e.statusCode, 400);
  assert.equal(e.message, 'This reset link is invalid or has expired. Request a new one.');
});

test('reset: a password changed after the link was sent kills the link', async () => {
  const s = await fresh();
  await request(s);
  s.row.passwordHash = bcrypt.hashSync('set-by-super-admin', 4);
  const e = await errOf(s.service.resetPassword({ token: tokenFrom(s.sent[0]), password: 'brand-new-pass', ip: null }));
  assert.equal(e.code, 'RESET_LINK_INVALID');
});

test('reset: an admin deactivated after the link was sent cannot use it', async () => {
  const s = await fresh();
  await request(s);
  s.row.active = false;
  const e = await errOf(s.service.resetPassword({ token: tokenFrom(s.sent[0]), password: 'brand-new-pass', ip: null }));
  assert.equal(e.code, 'RESET_LINK_INVALID');
});

test('reset: a failing notice email does not undo the reset', async () => {
  const s = await fresh();
  await request(s);
  s.mail.fail = true;
  await s.service.resetPassword({ token: tokenFrom(s.sent[0]), password: 'brand-new-pass', ip: null });
  assert.ok(await bcrypt.compare('brand-new-pass', s.row.passwordHash));
});

test('after a reset, the new password still needs the OTP', async () => {
  const s = await fresh();
  await request(s);
  await s.service.resetPassword({ token: tokenFrom(s.sent[0]), password: 'brand-new-pass', ip: null });
  assert.deepEqual(await login(s, 'brand-new-pass'), { otpRequired: true, challengeId: 'challenge-1' });
});

test('reset: a Super Admin password change landing mid-reset is not overwritten', async () => {
  const s = await fresh();
  await request(s);
  const bySuperAdmin = bcrypt.hashSync('set-by-super-admin', 4);
  s.hooks.duringHash = () => {
    s.row.passwordHash = bySuperAdmin;
  };
  const e = await errOf(s.service.resetPassword({ token: tokenFrom(s.sent[0]), password: 'brand-new-pass', ip: null }));
  assert.equal(e.code, 'RESET_LINK_INVALID');
  assert.equal(s.row.passwordHash, bySuperAdmin);
  assert.ok(!s.audits.some((a) => a.action === 'ADMIN_PASSWORD_RESET'));
});
