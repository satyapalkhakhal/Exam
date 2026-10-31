// Candidates end to end against exam_test: import preview/confirm, list, RBAC,
// the role-change guard, eligibility session revocation and attempt reset.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { getSessionsValidAfter } from '../../src/modules/adminAuth/index.js';
import { createApp } from '../../src/app.js';

const SA = { email: 'super@cands.test', password: 'super-pass-123' };
const EV = { email: 'eval@cands.test', password: 'eval-pass-123' };
let app: Express;
let sa: request.Agent;
let ev: request.Agent;
let roleId = '';
let role2Id = '';

async function signIn(creds: { email: string; password: string }) {
  const stale = [...(await getRedis().keys('exam:otp:cd:admin_login:*')), ...(await getRedis().keys('exam:rl:*'))];
  if (stale.length > 0) await getRedis().del(...stale);
  const agent = request.agent(app);
  const login = await agent.post('/api/admin/auth/login').send(creds);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const verify = await agent.post('/api/admin/auth/verify-otp').send({ challengeId: login.body.data.challengeId, code: '123456' });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  return agent;
}

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  assert.match(env.REDIS_URL, /\/15$/);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE admin_audit_logs, candidate_status_history, exam_attempts, candidates, import_batches, questions, exam_settings, job_roles, admin_users RESTART IDENTITY CASCADE',
  );
  await getRedis().flushdb();
  for (const [c, name, role] of [
    [SA, 'C Super', 'SUPER_ADMIN'],
    [EV, 'C Eval', 'EVALUATOR'],
  ] as const) {
    await prisma.adminUser.create({ data: { email: c.email, name, role, passwordHash: await bcrypt.hash(c.password, 4) } });
  }
  roleId = (await prisma.jobRole.create({ data: { name: 'C Role', examSetting: { create: {} } } })).id;
  role2Id = (await prisma.jobRole.create({ data: { name: 'C Role Two', examSetting: { create: {} } } })).id;
  app = createApp();
  sa = await signIn(SA);
  ev = await signIn(EV);
});

after(async () => {
  await prisma.$disconnect();
  await getRedis().quit();
});

const HEAD = 'schooling.x_percentage,schooling.xii_percentage,roll_number,name,major_cpi,major.discipline,major.programme,email,hostel';
const csv = (rows: string[]) => Buffer.from([HEAD, ...rows].join('\n'));
const three = csv([
  '97.6,99.8,254101009,AJITH K K,8.67,Computer Science and Engineering,M.Tech,K.Ajith@iitg.ac.in,Brahmaputra',
  '90,91,254101010,Bina Rao,9.1,Electrical,B.Tech,bina@iitg.ac.in,',
  '80,81,254101011,Chandan Das,7.5,Civil,B.Tech,chandan@iitg.ac.in,',
]);

const preview = (agent: request.Agent, file: Buffer, jobRoleId: string) =>
  agent.post('/api/admin/candidates/import/preview').field('jobRoleId', jobRoleId).attach('file', file, 'c.csv');

test('template.csv carries the HR header row plus mobile and job_role', async () => {
  const res = await sa.get('/api/admin/candidates/template.csv');
  assert.equal(res.status, 200);
  assert.match(res.text, /^schooling\.x_percentage,.*,email,mobile,job_role/);
});

test('import 3 rows: preview then confirm; list total is 3; codes and lower-cased email stored', async () => {
  const p = await preview(sa, three, roleId);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.data.summary, { total: 3, valid: 3, errors: 0, duplicates: 0 });
  const c = await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(c.body.data, { imported: 3, skipped: 0 });

  const list = await sa.get('/api/admin/candidates');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 3);
  assert.equal(list.body.data.pageSize, 25);
  const codes = list.body.data.items.map((i: { candidateCode: string }) => i.candidateCode);
  assert.ok(codes.every((x: string) => /^ARH-EX-\d{6}$/.test(x)));
  assert.equal(new Set(codes).size, 3);
  const ajith = await prisma.candidate.findUniqueOrThrow({ where: { email: 'k.ajith@iitg.ac.in' } });
  assert.deepEqual(ajith.extra, { hostel: 'Brahmaputra' });
  assert.equal(list.body.data.items[0].flagCount, 0);
});

test('the same file again is 409 until forced; re-imported rows are EXISTS duplicates', async () => {
  const p = await preview(sa, three, roleId);
  assert.equal(p.body.data.summary.duplicates, 3);
  const c = await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId });
  assert.equal(c.status, 409);
  const f = await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId, force: true });
  assert.equal(f.status, 200);
  assert.deepEqual(f.body.data, { imported: 0, skipped: 3 });
});

test('list search, sort and filters; pageSize above 100 is rejected', async () => {
  const s = await sa.get('/api/admin/candidates?search=bina');
  assert.equal(s.body.data.total, 1);
  const sorted = await sa.get('/api/admin/candidates?sort=majorCpi&dir=desc');
  assert.equal(sorted.body.data.items[0].majorCpi, 9.1);
  assert.equal((await sa.get(`/api/admin/candidates?jobRoleId=${role2Id}`)).body.data.total, 0);
  assert.equal((await sa.get('/api/admin/candidates?pageSize=101')).status, 400);
});

test('flagCount is the exam flag score and flagged=true/false filters on it', async () => {
  const bina = await prisma.candidate.findUniqueOrThrow({ where: { email: 'bina@iitg.ac.in' } });
  const now = new Date();
  const attempt = await prisma.examAttempt.create({
    data: { candidateId: bina.id, status: 'SUBMITTED', startedAt: now, endsAt: now, submittedAt: now, activeSessionId: 's', startIp: '1.1.1.1', userAgent: 'ua', maxMarks: 10 },
  });
  const ev = (eventType: string) => ({ candidateId: bina.id, attemptId: attempt.id, eventType, ip: '1.1.1.1' });
  // one blocked paste + tab switched 3 times (counts once); a window blur alone never counts
  await prisma.activityLog.createMany({ data: [ev('PASTE_ATTEMPT'), ev('TAB_HIDDEN'), ev('TAB_HIDDEN'), ev('TAB_HIDDEN'), ev('WINDOW_BLUR')] });

  const list = await sa.get('/api/admin/candidates?search=bina');
  assert.equal(list.body.data.items[0].flagCount, 2);
  const flagged = await sa.get('/api/admin/candidates?flagged=true');
  assert.deepEqual(flagged.body.data.items.map((i: { id: string }) => i.id), [bina.id]);
  assert.equal(flagged.body.data.total, 1);
  const clean = await sa.get('/api/admin/candidates?flagged=false');
  assert.equal(clean.body.data.total, 2);
  assert.ok(clean.body.data.items.every((i: { id: string; flagCount: number }) => i.id !== bina.id && i.flagCount === 0));

  // detail: the exam module's flags object; the score matches the list's flagCount
  const d = await sa.get(`/api/admin/candidates/${bina.id}`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.data.candidate.flagCount, 2);
  assert.deepEqual(d.body.data.flags, {
    integrity: { pasteAttempts: 1, bulkInsert: 0, tabHidden: 3, blur: 1, ipChanges: 0 },
    location: [],
  });
});

test('an Evaluator calling list, detail or import gets 403', async () => {
  assert.equal((await ev.get('/api/admin/candidates')).status, 403);
  assert.equal((await preview(ev, three, roleId)).status, 403);
});

test('detail returns profile, extra, history and zero flags', async () => {
  const one = await prisma.candidate.findUniqueOrThrow({ where: { email: 'k.ajith@iitg.ac.in' } });
  const d = await sa.get(`/api/admin/candidates/${one.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.data.candidate.extra.hostel, 'Brahmaputra');
  assert.equal(d.body.data.attempt, null);
  assert.deepEqual(d.body.data.flags, { integrity: { pasteAttempts: 0, bulkInsert: 0, tabHidden: 0, blur: 0, ipChanges: 0 }, location: [] });
  assert.equal(d.body.data.activity.total, 0);
});

test('edit lower-cases email; a duplicate email is 409; role change allowed only before start', async () => {
  const bina = await prisma.candidate.findUniqueOrThrow({ where: { email: 'bina@iitg.ac.in' } });
  const e = await sa.patch(`/api/admin/candidates/${bina.id}`).send({ email: 'Bina.R@iitg.ac.in', mobile: '+91 98765 43210' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.data.email, 'bina.r@iitg.ac.in');
  assert.equal(e.body.data.mobile, '9876543210');
  assert.equal((await sa.patch(`/api/admin/candidates/${bina.id}`).send({ email: 'chandan@iitg.ac.in' })).status, 409);

  assert.equal((await sa.patch(`/api/admin/candidates/${bina.id}`).send({ jobRoleId: role2Id })).status, 200);
  await prisma.candidate.update({ where: { id: bina.id }, data: { status: 'IN_PROGRESS' } });
  const r = await sa.patch(`/api/admin/candidates/${bina.id}`).send({ jobRoleId: roleId });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ROLE_CHANGE_FORBIDDEN');
  await prisma.candidate.update({ where: { id: bina.id }, data: { status: 'NOT_STARTED' } });
});

test('eligibility and location-exempt toggles are audited; eligibility false revokes candidate sessions', async () => {
  const c = await prisma.candidate.findUniqueOrThrow({ where: { email: 'chandan@iitg.ac.in' } });
  const off = await sa.patch(`/api/admin/candidates/${c.id}/eligibility`).send({ eligible: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.eligible, false);
  assert.notEqual(await getSessionsValidAfter('candidate', c.id), null);
  assert.equal((await sa.patch(`/api/admin/candidates/${c.id}/location-exempt`).send({ exempt: true })).status, 400);
  const ex = await sa.patch(`/api/admin/candidates/${c.id}/location-exempt`).send({ exempt: true, reason: 'Travelling' });
  assert.equal(ex.body.data.locationExempt, true);
  const actions = (await prisma.adminAuditLog.findMany({ where: { entityId: c.id } })).map((a) => a.action);
  assert.deepEqual(actions.sort(), ['CANDIDATE_DISABLED', 'CANDIDATE_LOCATION_EXEMPTED']);
});

test('reset-attempt needs a 10+ char reason, marks the attempt RESET, and a new attempt can then be created', async () => {
  const c = await prisma.candidate.findUniqueOrThrow({ where: { email: 'k.ajith@iitg.ac.in' } });
  const now = new Date();
  const mk = () =>
    prisma.examAttempt.create({
      data: { candidateId: c.id, status: 'SUBMITTED', startedAt: now, endsAt: now, submittedAt: now, activeSessionId: 's', startIp: '1.1.1.1', userAgent: 'ua', maxMarks: 10 },
    });
  await mk();
  await prisma.candidate.update({ where: { id: c.id }, data: { status: 'SUBMITTED' } });

  assert.equal((await sa.post(`/api/admin/candidates/${c.id}/reset-attempt`).send({ reason: 'short' })).status, 400);
  const r = await sa.post(`/api/admin/candidates/${c.id}/reset-attempt`).send({ reason: 'Power cut during the exam' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: c.id } })).status, 'NOT_STARTED');
  assert.equal((await prisma.examAttempt.findMany({ where: { candidateId: c.id } }))[0]?.status, 'RESET');
  const hist = await prisma.candidateStatusHistory.findMany({ where: { candidateId: c.id } });
  assert.equal(hist.length, 1);
  assert.equal(hist[0]?.comment, 'Power cut during the exam');
  assert.equal((await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_ATTEMPT_RESET', entityId: c.id } })), 1);

  await mk();
  assert.equal(await prisma.examAttempt.count({ where: { candidateId: c.id } }), 2);
  const again = await sa.post(`/api/admin/candidates/${c.id}/reset-attempt`).send({ reason: 'Second reset please' });
  assert.equal(again.status, 200);
  const none = await sa.post(`/api/admin/candidates/${c.id}/reset-attempt`).send({ reason: 'Nothing left to reset' });
  assert.equal(none.status, 409);
});

test('preview reports source line numbers when a blank row sits inside the file', async () => {
  const file = Buffer.from([HEAD, ',,,,,,,,', '90,91,1,Dev Rao,11,Civil,B.Tech,dev@iitg.ac.in,'].join('\n'));
  const p = await preview(sa, file, roleId);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.data.errors.map((e: { row: number; field: string }) => [e.row, e.field]), [[3, 'major_cpi']]);
});

test('create one candidate by hand: code minted, email lower-cased, mobile normalised, audited; evaluator is 403', async () => {
  const res = await sa.post('/api/admin/candidates').send({
    fullName: 'Dipak Rout',
    email: 'Dipak.Rout@Cands.test',
    mobile: '+91 90045 41335',
    rollNumber: '11111',
    xPercentage: 80,
    xiiPercentage: 80,
    jobRoleId: roleId,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const c = res.body.data;
  assert.match(c.candidateCode, /^ARH-EX-\d{6}$/);
  assert.equal(c.email, 'dipak.rout@cands.test');
  assert.equal(c.mobile, '9004541335');
  assert.equal(c.status, 'NOT_STARTED');
  assert.equal(c.majorCpi, null);
  const audit = await prisma.adminAuditLog.findFirst({ where: { entityId: c.id, action: 'CANDIDATE_CREATED' } });
  assert.ok(audit);

  const dupEmail = await sa.post('/api/admin/candidates').send({ fullName: 'Other', email: 'dipak.rout@cands.test', jobRoleId: roleId });
  assert.equal(dupEmail.status, 409);
  const dupMobile = await sa.post('/api/admin/candidates').send({ fullName: 'Other', email: 'other@cands.test', mobile: '9004541335', jobRoleId: roleId });
  assert.equal(dupMobile.status, 409);

  const minimal = await sa.post('/api/admin/candidates').send({ fullName: 'Only Required', email: 'min@cands.test', jobRoleId: roleId });
  assert.equal(minimal.status, 201, 'name, email and role are the only required fields');

  for (const bad of [
    { fullName: 'X', email: 'x@cands.test', jobRoleId: roleId },
    { fullName: 'Bad Mail', email: 'dipak', jobRoleId: roleId },
    { fullName: 'Bad Pct', email: 'p@cands.test', xPercentage: 101, jobRoleId: roleId },
    { fullName: 'Bad Cpi', email: 'q@cands.test', majorCpi: 11, jobRoleId: roleId },
    { fullName: 'No Role', email: 'r@cands.test' },
  ]) {
    assert.equal((await sa.post('/api/admin/candidates').send(bad)).status, 400, JSON.stringify(bad));
  }
  const ghostRole = await sa.post('/api/admin/candidates').send({ fullName: 'Ghost Role', email: 'g@cands.test', jobRoleId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(ghostRole.status, 404);

  assert.equal((await ev.post('/api/admin/candidates').send({ fullName: 'Eval Try', email: 'e@cands.test', jobRoleId: roleId })).status, 403);
});
