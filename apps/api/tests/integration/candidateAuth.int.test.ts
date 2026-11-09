// Candidate sign-in, location capture and the exam info read, end to end against
// exam_test and Redis db 15 (static OTP: no messaging channel is configured).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createApp } from '../../src/app.js';
import crypto from 'node:crypto';
import { createApplication, createCandidate } from './helpers.js';
import {
  CANDIDATE_OTP_IP_LIMIT,
  CANDIDATE_VERIFY_ID_LIMIT,
  LOCATION_LIMIT,
} from '../../src/shared/middleware/rateLimit.js';

const EMAIL = 'cand@int.test';
const MASKED_EMAIL = 'c****d@int.test';
let app: Express;
let candidateId = '';
let roleId = '';
const REG_EMAIL = 'reg@int.test';
let regId = '';

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  assert.match(env.REDIS_URL, /\/15$/);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE candidate_login_logs, activity_logs, admin_audit_logs, candidate_accounts, candidates, exam_settings, job_roles RESTART IDENTITY CASCADE',
  );
  const role = await prisma.jobRole.create({ data: { name: 'Analyst' } });
  roleId = role.id;
  await prisma.examSetting.create({
    data: { jobRoleId: role.id, durationMinutes: 45, instructions: 'Be honest.', isOpen: true, windowEnd: new Date('2030-01-01T00:00:00Z') },
  });
  const c = await createCandidate({ candidateCode: 'C-001', fullName: 'Asha Rao', email: EMAIL, mobile: '9876543210', jobRoleId: role.id });
  candidateId = c.id;
  await createCandidate({ candidateCode: 'C-002', fullName: 'Not Eligible', email: 'no@int.test', mobile: '9000000002', jobRoleId: role.id, eligible: false });
  const r = await createCandidate({ candidateCode: 'C-003', fullName: 'Ravi Nair', email: REG_EMAIL, rollNumber: 'R-003', jobRoleId: role.id });
  regId = r.id;
  app = createApp();
});

beforeEach(async () => {
  await getRedis().flushdb();
});

after(async () => {
  await prisma.$disconnect();
  await getRedis().quit();
});

/** The mobile lives on the account; each application carries a copy. */
async function clearMobile(accountId: string) {
  await prisma.candidateAccount.update({ where: { id: accountId }, data: { mobile: null } });
  await prisma.candidate.updateMany({ where: { accountId }, data: { mobile: null } });
}

async function signIn(identifier = EMAIL) {
  const agent = request.agent(app);
  const r1 = await agent.post('/api/candidate/auth/request-otp').send({ identifier });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await agent.post('/api/candidate/auth/verify-otp').send({ identifier, code: '123456' });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  return { agent, verify: r2 };
}

const cookies = (res: request.Response): string[] => {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : [];
};

test('an unknown email gets the generic 200 and no OTP key is created', async () => {
  const res = await request(app).post('/api/candidate/auth/request-otp').send({ identifier: 'ghost@int.test' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, data: { sent: true } });
  assert.deepEqual(await getRedis().keys('exam:otp:*'), []);
});

test('an ineligible candidate gets the same 200 and no OTP key', async () => {
  const res = await request(app).post('/api/candidate/auth/request-otp').send({ identifier: 'no@int.test' });
  assert.deepEqual(res.body, { success: true, data: { sent: true } });
  assert.deepEqual(await getRedis().keys('exam:otp:*'), []);
});

test('a known email gets 200 and an OTP key; a second request inside 60 s is 429 OTP_COOLDOWN', async () => {
  const a = await request(app).post('/api/candidate/auth/request-otp').send({ identifier: EMAIL });
  assert.equal(a.status, 200);
  assert.equal((await getRedis().keys('exam:otp:candidate_login:*')).length, 1);
  const b = await request(app).post('/api/candidate/auth/request-otp').send({ identifier: EMAIL });
  assert.equal(b.status, 429);
  assert.equal(b.body.error.code, 'OTP_COOLDOWN');
});

test('a 10-digit mobile identifier works', async () => {
  const { verify } = await signIn('9876543210');
  assert.equal(verify.body.data.candidate.id, candidateId);
});

test('a malformed identifier is a 400', async () => {
  const res = await request(app).post('/api/candidate/auth/request-otp').send({ identifier: '12345' });
  assert.equal(res.status, 400);
});

test('verify with 123456 returns CandidateSelf, sets cand cookies (httpOnly, Strict, /api/candidate) and /me shows locationCaptured:false', async () => {
  const { agent, verify } = await signIn();
  assert.deepEqual(verify.body.data, {
    candidate: {
      id: candidateId,
      fullName: 'Asha Rao',
      email: MASKED_EMAIL,
      locationCaptured: false,
      locationExempt: false,
      examCount: 1,
    },
  });
  for (const name of ['exam_cand_at', 'exam_cand_rt']) {
    const c = cookies(verify).find((x) => x.startsWith(`${name}=`));
    assert.ok(c, `${name} set`);
    assert.match(c, /HttpOnly/i);
    assert.match(c, /SameSite=Strict/i);
    assert.match(c, /Path=\/api\/candidate/);
  }
  const me = await agent.get('/api/candidate/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.data.candidate.locationCaptured, false);
  assert.equal(me.body.data.candidate.id, candidateId);
});

test('wrong identifier, wrong code and ineligible candidate all give OTP_INVALID', async () => {
  await request(app).post('/api/candidate/auth/request-otp').send({ identifier: EMAIL });
  const wrongCode = await request(app).post('/api/candidate/auth/verify-otp').send({ identifier: EMAIL, code: '000000' });
  assert.equal(wrongCode.status, 400);
  assert.equal(wrongCode.body.error.code, 'OTP_INVALID');
  const unknown = await request(app).post('/api/candidate/auth/verify-otp').send({ identifier: 'ghost@int.test', code: '123456' });
  assert.equal(unknown.body.error.code, 'OTP_INVALID');
  const inelig = await request(app).post('/api/candidate/auth/verify-otp').send({ identifier: 'no@int.test', code: '123456' });
  assert.equal(inelig.body.error.code, 'OTP_INVALID');
});

test('verify writes an OTP_VERIFIED activity event', async () => {
  await prisma.activityLog.deleteMany({ where: { candidateId, eventType: 'OTP_VERIFIED' } });
  await signIn();
  const n = await prisma.activityLog.count({ where: { candidateId, eventType: 'OTP_VERIFIED' } });
  assert.equal(n, 1);
});

test('GRANTED location flips /me to locationCaptured:true and returns the device summary; a new login asks again', async () => {
  await prisma.activityLog.deleteMany({ where: { candidateId, eventType: 'LOCATION_CAPTURED' } });
  const { agent } = await signIn();
  const loc = await agent
    .post('/api/candidate/location')
    .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    .send({ stage: 'LOGIN', permission: 'GRANTED', latitude: 26.14, longitude: 91.73, accuracyM: 30 });
  assert.equal(loc.status, 200, JSON.stringify(loc.body));
  assert.equal(loc.body.data.locationCaptured, true);
  assert.equal(loc.body.data.browser, 'Chrome');
  assert.equal(loc.body.data.os, 'Windows');
  assert.equal(loc.body.data.deviceType, 'desktop');
  assert.equal(typeof loc.body.data.ip, 'string');
  assert.equal((await agent.get('/api/candidate/me')).body.data.candidate.locationCaptured, true);
  assert.equal(await prisma.activityLog.count({ where: { candidateId, eventType: 'LOCATION_CAPTURED' } }), 1);

  await getRedis().del(...(await getRedis().keys('exam:otp:cd:*')));
  const second = await signIn();
  assert.equal(second.verify.body.data.candidate.locationCaptured, false);
});

test('a refresh keeps the same login family, so locationCaptured survives it', async () => {
  const { agent } = await signIn();
  await agent.post('/api/candidate/location').send({ stage: 'LOGIN', permission: 'GRANTED', latitude: 1, longitude: 2, accuracyM: 5 });
  const r = await agent.post('/api/candidate/auth/refresh');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.candidate.locationCaptured, true);
  assert.equal((await agent.get('/api/candidate/me')).body.data.candidate.locationCaptured, true);
});

test('I3: two tabs refreshing with the same cookie: the late one is a plain 401 that keeps the login and its cookies', async () => {
  const { agent, verify } = await signIn();
  const oldRt = cookies(verify).find((c) => c.startsWith('exam_cand_rt='))!.split(';')[0]!;
  assert.equal((await agent.post('/api/candidate/auth/refresh')).status, 200);
  // The second tab's refresh left with the old cookie before the first tab's rotation landed.
  const late = await request(app).post('/api/candidate/auth/refresh').set('Cookie', oldRt);
  assert.equal(late.status, 401);
  assert.equal(cookies(late).length, 0, 'no Set-Cookie clearing the shared jar');
  // The login survives: the rotated cookie (what both tabs now hold) still works.
  assert.equal((await agent.get('/api/candidate/me')).status, 200);
  assert.equal((await agent.post('/api/candidate/auth/refresh')).status, 200);
});

test('denied / timeout / unavailable are logged without coordinates and leave locationCaptured false; an EXAM_START location is refused here (it travels with the exam start)', async () => {
  await prisma.activityLog.deleteMany({ where: { candidateId, eventType: { startsWith: 'LOCATION_' } } });
  const { agent } = await signIn();
  const d = await agent.post('/api/candidate/location').send({ stage: 'LOGIN', permission: 'DENIED', latitude: 10, longitude: 10 });
  assert.equal(d.status, 200);
  assert.equal(d.body.data.locationCaptured, false);
  await agent.post('/api/candidate/location').send({ stage: 'LOGIN', permission: 'TIMEOUT' });
  await agent.post('/api/candidate/location').send({ stage: 'LOGIN', permission: 'UNSUPPORTED' });
  const s = await agent.post('/api/candidate/location').send({ stage: 'EXAM_START', permission: 'GRANTED', latitude: 1, longitude: 2 });
  assert.equal(s.status, 400);
  assert.equal((await agent.get('/api/candidate/me')).body.data.candidate.locationCaptured, false);

  const denied = await prisma.candidateLoginLog.findFirstOrThrow({ where: { candidateId, permission: 'DENIED' } });
  assert.equal(denied.latitude, null);
  assert.equal(denied.longitude, null);
  assert.ok(denied.sessionFamily);
  assert.equal(await prisma.activityLog.count({ where: { candidateId, eventType: 'LOCATION_DENIED' } }), 1);
  assert.equal(await prisma.activityLog.count({ where: { candidateId, eventType: 'LOCATION_TIMEOUT' } }), 1);
  assert.equal(await prisma.activityLog.count({ where: { candidateId, eventType: 'LOCATION_UNAVAILABLE' } }), 1);
});

test('GRANTED without a latitude, or with out-of-range coordinates, is a 400', async () => {
  const { agent } = await signIn();
  const noLat = await agent.post('/api/candidate/location').send({ stage: 'LOGIN', permission: 'GRANTED', longitude: 2 });
  assert.equal(noLat.status, 400);
  const badLat = await agent.post('/api/candidate/location').send({ stage: 'LOGIN', permission: 'GRANTED', latitude: 91, longitude: 2 });
  assert.equal(badLat.status, 400);
  const badLng = await agent.post('/api/candidate/location').send({ stage: 'LOGIN', permission: 'GRANTED', latitude: 1, longitude: 181 });
  assert.equal(badLng.status, 400);
});

test('/me and /location need a candidate session', async () => {
  assert.equal((await request(app).get('/api/candidate/me')).status, 401);
  assert.equal((await request(app).post('/api/candidate/location').send({ stage: 'LOGIN', permission: 'DENIED' })).status, 401);
});

test('a candidate access cookie sent to /api/admin/auth/me is 401', async () => {
  const { verify } = await signIn();
  const at = cookies(verify).find((c) => c.startsWith('exam_cand_at='))!.split(';')[0]!.replace('exam_cand_at=', 'exam_admin_at=');
  const res = await request(app).get('/api/admin/auth/me').set('Cookie', at);
  assert.equal(res.status, 401);
});

test('logout revokes the session: refresh afterwards is 401', async () => {
  const { agent } = await signIn();
  assert.equal((await agent.post('/api/candidate/auth/logout')).status, 200);
  assert.equal((await agent.post('/api/candidate/auth/refresh')).status, 401);
});

test('the old /exam/info and /exam/* routes are gone', async () => {
  const { agent } = await signIn();
  assert.equal((await agent.get('/api/candidate/exam/info')).status, 404);
  assert.equal((await agent.get('/api/candidate/exam')).status, 404);
});

test('/exams lists the eligible applications of the account ordered by role name; ineligible ones are hidden; the detail is owned', async () => {
  const role2 = await prisma.jobRole.create({ data: { name: 'Auditor' } });
  await prisma.examSetting.create({ data: { jobRoleId: role2.id, durationMinutes: 30, instructions: 'Audit.', isOpen: false } });
  const role3 = await prisma.jobRole.create({ data: { name: 'Zoologist' } });
  const second = await createApplication(candidateId, { candidateCode: 'C-101', fullName: 'Asha Rao', jobRoleId: role2.id, locationExempt: true });
  await createApplication(candidateId, { candidateCode: 'C-102', fullName: 'Asha Rao', jobRoleId: role3.id, eligible: false });
  try {
    const { agent } = await signIn();
    const list = await agent.get('/api/candidate/exams');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.data.exams.map((e: { jobRole: { name: string } }) => e.jobRole.name), ['Analyst', 'Auditor']);
    const analyst = list.body.data.exams[0];
    assert.equal(analyst.durationMinutes, 45);
    assert.equal(analyst.windowEnd, '2030-01-01T00:00:00.000Z');
    assert.equal(analyst.instructions, 'Be honest.');
    assert.equal(analyst.isOpen, true);
    assert.equal(analyst.progress, 'NOT_STARTED');
    assert.equal(analyst.attempt, null);
    assert.ok(!Number.isNaN(Date.parse(list.body.data.serverNow)));
    assert.equal((await agent.get('/api/candidate/me')).body.data.candidate.examCount, 2);

    const one = await agent.get(`/api/candidate/exams/${second.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.data.exam.candidateCode, 'C-101');
    assert.equal(one.body.data.exam.locationExempt, true);

    // Someone else's application, an ineligible one and a made-up id are all a 404.
    const other = await prisma.candidate.findFirstOrThrow({ where: { candidateCode: 'C-003' } });
    const hidden = await prisma.candidate.findFirstOrThrow({ where: { candidateCode: 'C-102' } });
    for (const id of [other.id, hidden.id, crypto.randomUUID()]) {
      const res = await agent.get(`/api/candidate/exams/${id}`);
      assert.equal(res.status, 404, id);
      assert.equal((await agent.get(`/api/candidate/exams/${id}/state`)).status, 404);
      assert.equal((await agent.post(`/api/candidate/exams/${id}/start`).send({ location: { stage: 'EXAM_START', permission: 'DENIED' } })).status, 404);
    }
    assert.equal((await agent.get('/api/candidate/exams/not-a-uuid')).status, 400);
    assert.equal((await request(app).get('/api/candidate/exams')).status, 401);
  } finally {
    await prisma.candidate.deleteMany({ where: { candidateCode: { in: ['C-101', 'C-102'] } } });
  }
});

test('login by mobile and by email reach the same account, and LOGIN location is stored per eligible application', async () => {
  const role2 = await prisma.jobRole.create({ data: { name: 'Banker' } });
  await createApplication(candidateId, { candidateCode: 'C-201', fullName: 'Asha Rao', jobRoleId: role2.id });
  try {
    const byMobile = await signIn('9876543210');
    assert.equal(byMobile.verify.body.data.candidate.id, candidateId);
    await getRedis().flushdb();
    const byEmail = await signIn();
    assert.equal(byEmail.verify.body.data.candidate.id, candidateId);
    assert.equal(byEmail.verify.body.data.candidate.examCount, 2);
    await prisma.candidateLoginLog.deleteMany({ where: { candidate: { accountId: candidateId } } });
    const loc = await byEmail.agent.post('/api/candidate/location').send({ stage: 'LOGIN', permission: 'GRANTED', latitude: 1, longitude: 2 });
    assert.equal(loc.body.data.locationCaptured, true);
    assert.equal(await prisma.candidateLoginLog.count({ where: { candidate: { accountId: candidateId }, stage: 'LOGIN' } }), 2);
  } finally {
    await prisma.candidateLoginLog.deleteMany({ where: { candidate: { accountId: candidateId } } });
    await prisma.candidate.deleteMany({ where: { candidateCode: 'C-201' } });
  }
});

test('a deactivated (ineligible) candidate loses access on the next request', async () => {
  const { agent } = await signIn();
  await prisma.candidate.update({ where: { id: candidateId }, data: { eligible: false } });
  try {
    assert.equal((await agent.get('/api/candidate/me')).status, 401);
  } finally {
    await prisma.candidate.update({ where: { id: candidateId }, data: { eligible: true } });
  }
});

test('request-otp is limited to 5 per identifier per window', async () => {
  const keys = await getRedis().keys('exam:rl:*');
  if (keys.length) await getRedis().del(...keys);
  let last = 0;
  for (let i = 0; i < 6; i++) {
    last = (await request(app).post('/api/candidate/auth/request-otp').send({ identifier: 'limit@int.test' })).status;
  }
  assert.equal(last, 429);
});

test('request-otp tolerates a shared NAT: many identifiers from one IP are not throttled below 300', async () => {
  const keys = await getRedis().keys('exam:rl:*');
  if (keys.length) await getRedis().del(...keys);
  for (let i = 0; i < 40; i++) {
    const r = await request(app).post('/api/candidate/auth/request-otp').send({ identifier: `nat${i}@int.test` });
    assert.equal(r.status, 200);
  }
});

test('I5: one shared-NAT IP gets CANDIDATE_OTP_IP_LIMIT (10,000) request-otp and verify-otp per 10 min before 429', async () => {
  assert.equal(CANDIDATE_OTP_IP_LIMIT, 10_000);
  const keys = await getRedis().keys('exam:rl:*');
  if (keys.length) await getRedis().del(...keys);
  // 50 real requests from many identifiers, then pre-load the per-IP counter to the
  // limit (10,000 real requests would take minutes): the next request is refused.
  const burst = async (path: string, body: (i: number) => object, n: number) =>
    (await Promise.all(Array.from({ length: n }, (_, i) => request(app).post(path).send(body(i))))).map((r) => r.status);
  const fillTo = async (bucket: string) => {
    const [k] = await getRedis().keys(`exam:rl:${bucket}:*`);
    assert.ok(k, `counter for ${bucket} exists`);
    assert.equal(Number(await getRedis().get(k)), 50);
    await getRedis().set(k, String(CANDIDATE_OTP_IP_LIMIT), 'PX', 600_000);
  };
  assert.deepEqual([...new Set(await burst('/api/candidate/auth/request-otp', (i) => ({ identifier: `nat-burst${i}@int.test` }), 50))], [200]);
  await fillTo('candOtpIp');
  assert.equal((await request(app).post('/api/candidate/auth/request-otp').send({ identifier: 'nat-over@int.test' })).status, 429);
  assert.deepEqual([...new Set(await burst('/api/candidate/auth/verify-otp', (i) => ({ identifier: `nat-burst${i}@int.test`, code: '000000' }), 50))], [400]);
  await fillTo('candVerify');
  assert.equal((await request(app).post('/api/candidate/auth/verify-otp').send({ identifier: 'nat-over@int.test', code: '000000' })).status, 429);
  const after = await getRedis().keys('exam:rl:*');
  if (after.length) await getRedis().del(...after);
});

test('verify-otp is limited to CANDIDATE_VERIFY_ID_LIMIT (50) per identifier per window', async () => {
  assert.equal(CANDIDATE_VERIFY_ID_LIMIT, 50);
  const keys = await getRedis().keys('exam:rl:*');
  if (keys.length) await getRedis().del(...keys);
  let last = 0;
  for (let i = 0; i < CANDIDATE_VERIFY_ID_LIMIT + 1; i++) {
    last = (await request(app).post('/api/candidate/auth/verify-otp').send({ identifier: 'vlimit@int.test', code: '000000' })).status;
  }
  assert.equal(last, 429);
});

test('location is limited to LOCATION_LIMIT (1,000) per 10 min per candidate, keyed under exam:rl:candLocation:', async () => {
  assert.equal(LOCATION_LIMIT, 1_000);
  const { agent } = await signIn();
  const keys = await getRedis().keys('exam:rl:*');
  if (keys.length) await getRedis().del(...keys);
  let last = 0;
  for (let i = 0; i < 5; i++) {
    last = (await agent.post('/api/candidate/location').send({ stage: 'LOGIN', permission: 'TIMEOUT' })).status;
    assert.equal(last, 200);
  }
  // Pre-load the counter to the limit rather than sending 1,000 real requests.
  const [lk] = await getRedis().keys('exam:rl:candLocation:*');
  await getRedis().set(lk!, String(LOCATION_LIMIT), 'PX', 600_000);
  last = (await agent.post('/api/candidate/location').send({ stage: 'LOGIN', permission: 'TIMEOUT' })).status;
  assert.equal(last, 429);
  const rl = await getRedis().keys('exam:rl:candLocation:*');
  assert.equal(rl.length, 1);
  assert.ok(rl[0]!.endsWith(candidateId));
});

test('junk bodies do not share a per-identifier bucket: 20 malformed requests, then a valid candidate still works', async () => {
  const keys = await getRedis().keys('exam:rl:*');
  if (keys.length) await getRedis().del(...keys);
  const junk: unknown[] = [{}, { identifier: 5 }, { identifier: '' }, { identifier: 'nope' }, { identifier: null }];
  for (let i = 0; i < 20; i++) {
    const body = junk[i % junk.length] as object;
    assert.equal((await request(app).post('/api/candidate/auth/verify-otp').send(body)).status, 400);
    assert.equal((await request(app).post('/api/candidate/auth/request-otp').send(body)).status, 400);
  }
  await signIn();
});

test('email case variants share one per-identifier bucket', async () => {
  const keys = await getRedis().keys('exam:rl:*');
  if (keys.length) await getRedis().del(...keys);
  let last = 0;
  for (let i = 0; i < 6; i++) {
    last = (await request(app).post('/api/candidate/auth/request-otp').send({ identifier: i % 2 ? 'A@x.com' : 'a@x.com' })).status;
  }
  assert.equal(last, 429);
});

// --- first-time mobile registration -------------------------------------------

const REG = { email: REG_EMAIL, rollNumber: 'R-003', mobile: '9123456780' };
const linkKeys = () => getRedis().keys('exam:otp:candidate_mobile_link:*');

test('register-mobile: matching email + roll sends a code bound to (candidate, mobile); +91 and spaces are accepted', async () => {
  await clearMobile(regId);
  const res = await request(app).post('/api/candidate/auth/register-mobile/request').send({ ...REG, mobile: '+91 91234 56780' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { success: true, data: { sent: true } });
  assert.deepEqual(await linkKeys(), [`exam:otp:candidate_mobile_link:${regId}:9123456780`]);
});

test('register-mobile: wrong roll, unknown email, a mobile already used and an invalid mobile send nothing', async () => {
  await clearMobile(regId);
  for (const body of [
    { ...REG, rollNumber: 'R-999' },
    { ...REG, email: 'ghost@int.test' },
    { ...REG, mobile: '9876543210' },
  ]) {
    const res = await request(app).post('/api/candidate/auth/register-mobile/request').send(body);
    assert.deepEqual(res.body, { success: true, data: { sent: true } });
  }
  assert.deepEqual(await linkKeys(), []);
  const bad = await request(app).post('/api/candidate/auth/register-mobile/request').send({ ...REG, mobile: '12345' });
  assert.equal(bad.status, 400);
});

test('register-mobile: verify links the mobile, signs in, logs it; the mobile then works for login and cannot be re-linked', async () => {
  await clearMobile(regId);
  const agent = request.agent(app);
  assert.equal((await agent.post('/api/candidate/auth/register-mobile/request').send(REG)).status, 200);
  const wrongMobile = await agent.post('/api/candidate/auth/register-mobile/verify').send({ ...REG, mobile: '9123456781', code: '123456' });
  assert.equal(wrongMobile.status, 400, 'a code is only good for the number it was sent to');

  const v = await agent.post('/api/candidate/auth/register-mobile/verify').send({ ...REG, code: '123456' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.data.candidate.id, regId);
  assert.ok(cookies(v).some((c) => c.startsWith('exam_cand_at=')));
  assert.equal((await agent.get('/api/candidate/me')).status, 200);

  const row = await prisma.candidate.findUniqueOrThrow({ where: { id: regId } });
  assert.equal(row.mobile, '9123456780');
  assert.equal((await prisma.candidateAccount.findUniqueOrThrow({ where: { id: regId } })).mobile, '9123456780');
  const ev = await prisma.activityLog.findFirst({ where: { candidateId: regId, eventType: 'MOBILE_SELF_REGISTERED' } });
  assert.ok(ev);
  const audit = await prisma.adminAuditLog.findFirst({ where: { entityId: regId, action: 'CANDIDATE_MOBILE_SELF_REGISTERED' } });
  assert.ok(audit);

  await getRedis().flushdb();
  await signIn('9123456780');

  await getRedis().flushdb();
  const again = await request(app).post('/api/candidate/auth/register-mobile/request').send({ ...REG, mobile: '9123456789' });
  assert.deepEqual(again.body, { success: true, data: { sent: true } });
  assert.deepEqual(await linkKeys(), []);
  const refused = await prisma.activityLog.findFirst({ where: { candidateId: regId, eventType: 'MOBILE_LINK_REFUSED' } });
  assert.ok(refused);
});

test('register-mobile/request is limited to 5 per email per window', async () => {
  await clearMobile(regId);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    // Clear the 60 s per-code cooldown so only the per-email limiter can refuse.
    const otpKeys = await getRedis().keys('exam:otp:*');
    if (otpKeys.length) await getRedis().del(...otpKeys);
    statuses.push((await request(app).post('/api/candidate/auth/register-mobile/request').send(REG)).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
});

test('/exams tells the candidate whether they were selected for the next round: YES, NO or AWAITED', async () => {
  const email = 'selection@int.test';
  const c = await createCandidate({ candidateCode: 'SEL-1', fullName: 'Sel Person', email, jobRoleId: roleId, status: 'EVALUATED' });
  const { agent } = await signIn(email);
  const selection = async () => {
    const r = await agent.get('/api/candidate/exams');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data.exams.map((e: { selectedForNextRound: string }) => e.selectedForNextRound);
  };
  assert.deepEqual(await selection(), ['AWAITED']);
  await prisma.candidate.update({ where: { id: c.id }, data: { result: 'SHORTLISTED' } });
  assert.deepEqual(await selection(), ['YES']);
  await prisma.candidate.update({ where: { id: c.id }, data: { result: 'REJECTED' } });
  assert.deepEqual(await selection(), ['NO']);
  const detail = await agent.get(`/api/candidate/exams/${c.id}`);
  assert.equal(detail.body.data.exam.selectedForNextRound, 'NO');
});

test('/exams carries nearbyCount for the candidate: a number with a start location, null without', async () => {
  const at = new Date('2026-09-02T04:00:00Z');
  const near = await createCandidate({ candidateCode: 'NBC-1', fullName: 'Near One', email: 'near-one@int.test', jobRoleId: roleId });
  const me = await createCandidate({ candidateCode: 'NBC-2', fullName: 'Near Two', email: 'near-two@int.test', jobRoleId: roleId });
  for (const [id, lat] of [[near.id, 22.57260], [me.id, 22.57265]] as const) {
    await prisma.candidateLoginLog.create({
      data: { candidateId: id, stage: 'EXAM_START', permission: 'GRANTED', latitude: lat, longitude: 88.36390, createdAt: at, ip: '203.0.113.7', userAgent: 'ua', browser: 'x', os: 'x', deviceType: 'desktop' },
    });
  }
  const { agent } = await signIn('near-two@int.test');
  const list = await agent.get('/api/candidate/exams');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.data.exams[0].nearbyCount, 1);
  const lone = await createCandidate({ candidateCode: 'NBC-3', fullName: 'No Loc', email: 'no-loc@int.test', jobRoleId: roleId });
  const other = await signIn('no-loc@int.test');
  assert.equal((await other.agent.get('/api/candidate/exams')).body.data.exams[0].nearbyCount, null);
  assert.ok(lone);
});
