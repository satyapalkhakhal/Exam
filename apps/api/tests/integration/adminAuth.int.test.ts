// Admin auth, RBAC, admin users, audit and integrations mount, end to end
// against the exam_test database and Redis db 15, with the static OTP (no
// messaging channel is configured in exam_test).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createApp } from '../../src/app.js';
import { ADMIN_LOGIN_LIMIT } from '../../src/shared/middleware/rateLimit.js';
import { sha256 } from '../../src/shared/utils/hash.js';

const SA = { email: 'super@int.test', password: 'super-pass-123' };
const EV = { email: 'eval@int.test', password: 'eval-pass-123' };
let app: Express;
let superId = '';
let evalId = '';

before(async () => {
  // Refuse to wipe anything that is not the test database / test Redis db.
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  assert.match(env.REDIS_URL, /\/15$/);
  await prisma.$executeRawUnsafe('TRUNCATE TABLE admin_audit_logs, admin_users RESTART IDENTITY CASCADE');
  await getRedis().flushdb();
  const sa = await prisma.adminUser.create({
    data: { email: SA.email, name: 'Int Super', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash(SA.password, 4) },
  });
  const ev = await prisma.adminUser.create({
    data: { email: EV.email, name: 'Int Eval', role: 'EVALUATOR', passwordHash: await bcrypt.hash(EV.password, 4) },
  });
  superId = sa.id;
  evalId = ev.id;
  app = createApp();
});

after(async () => {
  await prisma.$disconnect();
  await getRedis().quit();
});

async function signIn(creds: { email: string; password: string }) {
  // Each sign-in issues a fresh OTP; drop the 60 s resend cooldown and the
  // login/verify rate-limit buckets so repeated sign-ins across tests don't trip them.
  const stale = [...(await getRedis().keys('exam:otp:cd:admin_login:*')), ...(await getRedis().keys('exam:rl:*'))];
  if (stale.length > 0) await getRedis().del(...stale);
  const agent = request.agent(app);
  const login = await agent.post('/api/admin/auth/login').send(creds);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.data.otpRequired, true);
  const verify = await agent
    .post('/api/admin/auth/verify-otp')
    .send({ challengeId: login.body.data.challengeId, code: '123456' });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  return { agent, verify };
}

const cookieHeader = (res: request.Response): string[] => {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : [];
};

test('login -> verify 123456 -> /me is 200; cookies are httpOnly, SameSite=Strict, path /api/admin', async () => {
  const { agent, verify } = await signIn(SA);
  assert.deepEqual(verify.body.data, { admin: { id: superId, name: 'Int Super', email: SA.email, role: 'SUPER_ADMIN' } });
  const cookies = cookieHeader(verify);
  for (const name of ['exam_admin_at', 'exam_admin_rt']) {
    const c = cookies.find((x) => x.startsWith(`${name}=`));
    assert.ok(c, `${name} set`);
    assert.match(c, /HttpOnly/i);
    assert.match(c, /SameSite=Strict/i);
    assert.match(c, /Path=\/api\/admin/);
  }
  const me = await agent.get('/api/admin/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.data, { admin: { id: superId, name: 'Int Super', email: SA.email, role: 'SUPER_ADMIN' } });
  const success = await prisma.adminAuditLog.count({ where: { adminId: superId, action: 'ADMIN_LOGIN_SUCCESS' } });
  assert.equal(success, 1);
});

test('no cookie -> 401 on /me and on Super Admin routes', async () => {
  const me = await request(app).get('/api/admin/auth/me');
  assert.equal(me.status, 401);
  assert.equal(me.body.error.code, 'UNAUTHORIZED');
  assert.equal((await request(app).get('/api/admin/users')).status, 401);
  assert.equal((await request(app).get('/api/admin/integrations')).status, 401);
});

test('an EVALUATOR calling GET /api/admin/users gets 403 and the denial is audited', async () => {
  const { agent } = await signIn(EV);
  const res = await agent.get('/api/admin/users');
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');
  assert.equal((await agent.get('/api/admin/audit')).status, 403);
  assert.equal((await agent.get('/api/admin/integrations')).status, 403);
  const denied = await prisma.adminAuditLog.count({ where: { adminId: evalId, action: 'PERMISSION_DENIED' } });
  assert.equal(denied, 3);
});

test('wrong password and unknown email return the same generic 401', async () => {
  const a = await request(app).post('/api/admin/auth/login').send({ email: SA.email, password: 'nope-nope' });
  const b = await request(app).post('/api/admin/auth/login').send({ email: 'ghost@int.test', password: 'nope-nope' });
  assert.equal(a.status, 401);
  assert.deepEqual(a.body, b.body);
  // leave the Super Admin with a clean counter for later tests
  await prisma.adminUser.update({ where: { id: superId }, data: { failedLoginCount: 0 } });
});

test('refresh rotates the cookie; logout revokes it', async () => {
  const { agent, verify } = await signIn(SA);
  const firstRt = cookieHeader(verify).find((c) => c.startsWith('exam_admin_rt='));
  const refreshed = await agent.post('/api/admin/auth/refresh');
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.data.admin.id, superId);
  const secondRt = cookieHeader(refreshed).find((c) => c.startsWith('exam_admin_rt='));
  assert.ok(secondRt && secondRt !== firstRt);
  assert.equal((await agent.post('/api/admin/auth/logout')).status, 200);
  assert.equal((await agent.get('/api/admin/auth/me')).status, 401);
  // the old refresh value no longer works either
  const replay = await request(app).post('/api/admin/auth/refresh').set('Cookie', secondRt.split(';')[0]!);
  assert.equal(replay.status, 401);
  assert.equal(await prisma.adminAuditLog.count({ where: { adminId: superId, action: 'ADMIN_LOGOUT' } }), 1);
});

test('Super Admin manages admin users; last active Super Admin cannot be demoted or self-deactivated', async () => {
  const { agent } = await signIn(SA);
  const list = await agent.get('/api/admin/users');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 2);
  assert.equal(list.body.data.page, 1);
  assert.ok(list.body.data.pageSize > 0);
  assert.ok(list.body.data.items.every((u: Record<string, unknown>) => !('passwordHash' in u)));

  const created = await agent
    .post('/api/admin/users')
    .send({ name: 'New Eval', email: 'NEW@int.test', mobile: '+91 98765 43210', role: 'EVALUATOR', password: 'new-pass-123' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.email, 'new@int.test');
  assert.equal(created.body.data.mobile, '9876543210');
  const noMobile = await agent
    .post('/api/admin/users')
    .send({ name: 'No Mobile', email: 'nomobile@int.test', role: 'EVALUATOR', password: 'new-pass-123' });
  assert.equal(noMobile.status, 400, 'a new admin needs a mobile for login codes');
  const dup = await agent
    .post('/api/admin/users')
    .send({ name: 'Dup', email: 'new@int.test', mobile: '9876543211', role: 'EVALUATOR', password: 'new-pass-123' });
  assert.equal(dup.status, 409);

  const demote = await agent.patch(`/api/admin/users/${superId}`).send({ role: 'EVALUATOR' });
  assert.equal(demote.status, 409);
  assert.equal(demote.body.error.code, 'CONFLICT');
  const selfOff = await agent.patch(`/api/admin/users/${superId}`).send({ active: false });
  assert.equal(selfOff.status, 409);

  await prisma.adminUser.update({ where: { id: evalId }, data: { failedLoginCount: 4, lockedUntil: new Date(Date.now() + 600_000) } });
  const reset = await agent.patch(`/api/admin/users/${evalId}`).send({ password: 'fresh-pass-123', name: 'Int Eval 2' });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const ev = await prisma.adminUser.findUniqueOrThrow({ where: { id: evalId } });
  assert.equal(ev.failedLoginCount, 0);
  assert.equal(ev.lockedUntil, null);
  assert.equal(ev.name, 'Int Eval 2');
  assert.ok(await bcrypt.compare('fresh-pass-123', ev.passwordHash));

  const setMobile = await agent.patch(`/api/admin/users/${evalId}`).send({ mobile: '9123456789' });
  assert.equal(setMobile.status, 200, JSON.stringify(setMobile.body));
  assert.equal(setMobile.body.data.mobile, '9123456789');
  const badMobile = await agent.patch(`/api/admin/users/${evalId}`).send({ mobile: '12345' });
  assert.equal(badMobile.status, 400);
  const cleared = await agent.patch(`/api/admin/users/${evalId}`).send({ mobile: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.mobile, null);
});

test('audit list is paginated and filterable; integrations GET reports candidatesWithoutMobile', async () => {
  const { agent } = await signIn(SA);
  const audit = await agent.get('/api/admin/audit').query({ entity: 'admin_user', page: 1 });
  assert.equal(audit.status, 200);
  const { items, total, page, pageSize } = audit.body.data;
  assert.ok(total >= 1 && page === 1 && pageSize > 0);
  assert.ok(items.every((i: { entity: string }) => i.entity === 'admin_user'));
  assert.ok(items.some((i: { action: string; adminName: string | null }) => i.action === 'ADMIN_USER_CREATED' && i.adminName === 'Int Super'));
  const bad = await agent.get('/api/admin/audit').query({ adminId: 'not-a-uuid' });
  assert.equal(bad.status, 400);

  const integ = await agent.get('/api/admin/integrations');
  assert.equal(integ.status, 200);
  assert.equal(typeof integ.body.data.candidatesWithoutMobile, 'number');
  assert.ok('sms' in integ.body.data && 'email' in integ.body.data);
});

test('admin login is rate limited to ADMIN_LOGIN_LIMIT (50) per 15 min per IP + email, counted in Redis under exam:rl:', async () => {
  assert.equal(ADMIN_LOGIN_LIMIT, 50);
  const creds = { email: 'flood@int.test', password: 'whatever-1' };
  for (let i = 0; i < ADMIN_LOGIN_LIMIT; i++) {
    assert.equal((await request(app).post('/api/admin/auth/login').send(creds)).status, 401);
  }
  const blocked = await request(app).post('/api/admin/auth/login').send(creds);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  assert.ok((await getRedis().keys('exam:rl:adminLogin:*')).some((k) => k.includes('flood@int.test')));
  // a different email from the same IP is a different bucket
  const other = await request(app).post('/api/admin/auth/login').send({ email: 'other@int.test', password: 'x' });
  assert.equal(other.status, 401);
});

const rtOf = (res: request.Response): string => cookieHeader(res).find((c) => c.startsWith('exam_admin_rt='))!.split(';')[0]!;
const atOf = (res: request.Response): string => cookieHeader(res).find((c) => c.startsWith('exam_admin_at='))!.split(';')[0]!;

test('password reset (PATCH) evicts the target: old refresh and old access token both 401', async () => {
  const { verify: evVerify } = await signIn({ email: EV.email, password: 'fresh-pass-123' });
  const oldRt = rtOf(evVerify);
  const oldAt = atOf(evVerify);
  assert.equal((await request(app).get('/api/admin/auth/me').set('Cookie', oldAt)).status, 200);
  const { agent } = await signIn(SA);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await agent.patch(`/api/admin/users/${evalId}`).send({ password: 'reset-pass-456' })).status, 200);
  assert.equal((await request(app).post('/api/admin/auth/refresh').set('Cookie', oldRt)).status, 401);
  assert.equal((await request(app).get('/api/admin/auth/me').set('Cookie', oldAt)).status, 401);
  // a fresh sign-in after the reset works
  const { agent: again } = await signIn({ email: EV.email, password: 'reset-pass-456' });
  assert.equal((await again.get('/api/admin/auth/me')).status, 200);
});

test('deactivate -> reactivate does not revive the old refresh token', async () => {
  const { verify: evVerify } = await signIn({ email: EV.email, password: 'reset-pass-456' });
  const oldRt = rtOf(evVerify);
  const { agent } = await signIn(SA);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await agent.patch(`/api/admin/users/${evalId}`).send({ active: false })).status, 200);
  assert.equal((await agent.patch(`/api/admin/users/${evalId}`).send({ active: true })).status, 200);
  assert.equal((await request(app).post('/api/admin/auth/refresh').set('Cookie', oldRt)).status, 401);
});

test('logout-all evicts every session of the caller', async () => {
  const one = await signIn({ email: EV.email, password: 'reset-pass-456' });
  const two = await signIn({ email: EV.email, password: 'reset-pass-456' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await one.agent.post('/api/admin/auth/logout-all')).status, 200);
  assert.equal((await two.agent.get('/api/admin/auth/me')).status, 401);
  assert.equal((await request(app).post('/api/admin/auth/refresh').set('Cookie', rtOf(two.verify))).status, 401);
});

/** Moves a rotated token's "used" marker past the rotation grace, so its next reuse counts as theft. */
async function backdateRotation(rtCookie: string): Promise<void> {
  const key = `exam:rt:used:admin:${sha256(rtCookie.slice(rtCookie.indexOf('=') + 1))}`;
  const raw = await getRedis().get(key);
  assert.ok(raw, 'used marker exists');
  const marker = JSON.parse(raw) as { rotatedAt: number };
  await getRedis().set(key, JSON.stringify({ ...marker, rotatedAt: marker.rotatedAt - 60_000 }), 'KEEPTTL');
}

test('refresh-token reuse is audited as ADMIN_REFRESH_REUSE', async () => {
  const { verify } = await signIn(SA);
  const oldRt = rtOf(verify);
  assert.equal((await request(app).post('/api/admin/auth/refresh').set('Cookie', oldRt)).status, 200);
  // Inside the rotation grace a reuse is a second tab, not theft: refused, not audited, cookies kept.
  const race = await request(app).post('/api/admin/auth/refresh').set('Cookie', oldRt);
  assert.equal(race.status, 401);
  assert.equal(cookieHeader(race).length, 0);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'ADMIN_REFRESH_REUSE' } }), 0);
  await backdateRotation(oldRt);
  assert.equal((await request(app).post('/api/admin/auth/refresh').set('Cookie', oldRt)).status, 401);
  const rows = await prisma.adminAuditLog.findMany({ where: { action: 'ADMIN_REFRESH_REUSE' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.adminId, superId);
  assert.ok(rows[0]!.ip);
});

test('verify-otp is rate limited to 10 per 10 min per IP under exam:rl:', async () => {
  const stale = await getRedis().keys('exam:rl:*');
  if (stale.length > 0) await getRedis().del(...stale);
  for (let i = 0; i < 10; i++) {
    const r = await request(app).post('/api/admin/auth/verify-otp').send({ challengeId: `nope-${i}`, code: '000000' });
    assert.equal(r.status, 400);
  }
  const blocked = await request(app).post('/api/admin/auth/verify-otp').send({ challengeId: 'nope-x', code: '000000' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  assert.equal((await getRedis().keys('exam:rl:adminOtpVerify:*')).length, 1);
});

test('after logout the old admin access cookie is 401 (its family is gone)', async () => {
  const { agent, verify } = await signIn(SA);
  const oldAt = atOf(verify);
  assert.equal((await request(app).get('/api/admin/auth/me').set('Cookie', oldAt)).status, 200);
  assert.equal((await agent.post('/api/admin/auth/logout')).status, 200);
  assert.equal((await request(app).get('/api/admin/auth/me').set('Cookie', oldAt)).status, 401);
  assert.equal((await request(app).get('/api/admin/users').set('Cookie', oldAt)).status, 401);
});
