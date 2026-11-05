// Candidates end to end against exam_test: import preview/confirm, list, RBAC,
// the role-change guard, eligibility session revocation and attempt reset.

import { test, before, after } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { getSessionsValidAfter } from '../../src/modules/adminAuth/index.js';
import { createApp } from '../../src/app.js';
import { createApplication, createCandidate, createCandidates } from './helpers.js';

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
    'TRUNCATE TABLE admin_audit_logs, candidate_status_history, exam_attempts, candidate_accounts, candidates, import_batches, questions, exam_settings, job_roles, admin_users RESTART IDENTITY CASCADE',
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
  const ajith = await prisma.candidate.findFirstOrThrow({ where: { email: 'k.ajith@iitg.ac.in' } });
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
  const bina = await prisma.candidate.findFirstOrThrow({ where: { email: 'bina@iitg.ac.in' } });
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
  const one = await prisma.candidate.findFirstOrThrow({ where: { email: 'k.ajith@iitg.ac.in' } });
  const d = await sa.get(`/api/admin/candidates/${one.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.data.candidate.extra.hostel, 'Brahmaputra');
  assert.equal(d.body.data.attempt, null);
  assert.deepEqual(d.body.data.flags, { integrity: { pasteAttempts: 0, bulkInsert: 0, tabHidden: 0, blur: 0, ipChanges: 0 }, location: [] });
  assert.equal(d.body.data.activity.total, 0);
  assert.equal(d.body.data.candidate.result, null);
});

test('edit lower-cases email; a duplicate email is 409; role change allowed only before start', async () => {
  const bina = await prisma.candidate.findFirstOrThrow({ where: { email: 'bina@iitg.ac.in' } });
  const e = await sa.patch(`/api/admin/candidates/${bina.id}`).send({ email: 'Bina.R@iitg.ac.in', mobile: '+91 98765 43210' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.data.email, 'b****r@iitg.ac.in', 'responses are masked');
  const saved = await prisma.candidate.findUniqueOrThrow({ where: { id: bina.id } });
  assert.deepEqual({ email: saved.email, mobile: saved.mobile }, { email: 'bina.r@iitg.ac.in', mobile: '9876543210' });
  assert.equal((await sa.patch(`/api/admin/candidates/${bina.id}`).send({ email: 'chandan@iitg.ac.in' })).status, 409);

  assert.equal((await sa.patch(`/api/admin/candidates/${bina.id}`).send({ jobRoleId: role2Id })).status, 200);
  await prisma.candidate.update({ where: { id: bina.id }, data: { status: 'IN_PROGRESS' } });
  const r = await sa.patch(`/api/admin/candidates/${bina.id}`).send({ jobRoleId: roleId });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ROLE_CHANGE_FORBIDDEN');
  await prisma.candidate.update({ where: { id: bina.id }, data: { status: 'NOT_STARTED' } });
});

test('eligibility and location-exempt toggles are audited; eligibility false revokes candidate sessions', async () => {
  const c = await prisma.candidate.findFirstOrThrow({ where: { email: 'chandan@iitg.ac.in' } });
  const off = await sa.patch(`/api/admin/candidates/${c.id}/eligibility`).send({ eligible: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.eligible, false);
  assert.notEqual(await getSessionsValidAfter('candidate', c.accountId), null);
  assert.equal((await sa.patch(`/api/admin/candidates/${c.id}/location-exempt`).send({ exempt: true })).status, 400);
  const ex = await sa.patch(`/api/admin/candidates/${c.id}/location-exempt`).send({ exempt: true, reason: 'Travelling' });
  assert.equal(ex.body.data.locationExempt, true);
  const actions = (await prisma.adminAuditLog.findMany({ where: { entityId: c.id } })).map((a) => a.action);
  assert.deepEqual(actions.sort(), ['CANDIDATE_DISABLED', 'CANDIDATE_LOCATION_EXEMPTED']);
});

test('reset-attempt needs a 10+ char reason, marks the attempt RESET, and a new attempt can then be created', async () => {
  const c = await prisma.candidate.findFirstOrThrow({ where: { email: 'k.ajith@iitg.ac.in' } });
  const now = new Date();
  const mk = () =>
    prisma.examAttempt.create({
      data: { candidateId: c.id, status: 'SUBMITTED', startedAt: now, endsAt: now, submittedAt: now, activeSessionId: 's', startIp: '1.1.1.1', userAgent: 'ua', maxMarks: 10 },
    });
  await mk();
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { email: SA.email } });
  await prisma.candidate.update({ where: { id: c.id }, data: { status: 'EVALUATED', result: 'REJECTED', resultAt: now, resultById: admin.id } });

  assert.equal((await sa.post(`/api/admin/candidates/${c.id}/reset-attempt`).send({ reason: 'short' })).status, 400);
  const r = await sa.post(`/api/admin/candidates/${c.id}/reset-attempt`).send({ reason: 'Power cut during the exam' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: c.id } })).status, 'NOT_STARTED');
  assert.equal((await prisma.examAttempt.findMany({ where: { candidateId: c.id } }))[0]?.status, 'RESET');
  const hist = await prisma.candidateStatusHistory.findMany({ where: { candidateId: c.id } });
  assert.equal(hist.length, 1);
  assert.equal(hist[0]?.comment, 'Power cut during the exam');
  // a reset also clears HR's result
  const cleared = await prisma.candidate.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual({ result: cleared.result, at: cleared.resultAt, by: cleared.resultById }, { result: null, at: null, by: null });
  assert.deepEqual({ from: hist[0]?.fromStatus, fromResult: hist[0]?.fromResult, toResult: hist[0]?.toResult }, { from: 'EVALUATED', fromResult: 'REJECTED', toResult: null });
  const d = await sa.get(`/api/admin/candidates/${c.id}`);
  assert.equal(d.body.data.candidate.result, null);
  assert.deepEqual(
    d.body.data.history.map((x: { fromResult: string | null; toResult: string | null }) => [x.fromResult, x.toResult]),
    [['REJECTED', null]],
  );
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
  assert.equal(c.email, 'd****t@cands.test');
  assert.equal(c.mobile, '90******35');
  const stored = await prisma.candidate.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual({ email: stored.email, mobile: stored.mobile }, { email: 'dipak.rout@cands.test', mobile: '9004541335' });
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

// --- Re-upload with "update existing candidates" ---------------------------------

test('updateExisting: re-uploading a corrected file to the same job profile refreshes the applications (email + role)', async () => {
  const people = csv([
    '70,71,UPD001,Wrong Name One,7.1,Analytics,B.Tech,upd1@iitg.ac.in,',
    '72,73,UPD002,Wrong Name Two,7.2,Analytics,B.Tech,upd2@iitg.ac.in,',
  ]);
  const first = await preview(sa, people, roleId);
  assert.equal((await sa.post('/api/admin/candidates/import/confirm').send({ previewId: first.body.data.previewId })).status, 200);
  const before = await prisma.candidate.findFirstOrThrow({ where: { email: 'upd1@iitg.ac.in' } });
  assert.equal(before.jobRoleId, roleId);

  // Plain re-upload to the same profile: still skipped as duplicates, nothing changes.
  const plain = await preview(sa, people, roleId);
  assert.equal(plain.body.data.summary.duplicates, 2);
  assert.equal(plain.body.data.summary.updates, undefined);

  // Corrected file: one CPI blank (keep stored), one name fixed.
  const fixed = csv([
    '70,71,UPD001,Right Name One,,Analytics,B.Tech,upd1@iitg.ac.in,',
    '72,73,UPD002,Wrong Name Two,7.2,Analytics,B.Tech,UPD2@iitg.ac.in,',
  ]);
  const p = await sa
    .post('/api/admin/candidates/import/preview')
    .field('jobRoleId', roleId)
    .field('updateExisting', 'true')
    .attach('file', fixed, 'c.csv');
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.data.summary.updates, 2);
  assert.equal(p.body.data.summary.valid, 0);
  assert.equal(p.body.data.summary.duplicates, 0);
  assert.deepEqual(p.body.data.updates.map((u: { email: string }) => u.email).sort(), ['upd1@iitg.ac.in', 'upd2@iitg.ac.in']);

  const auditsBefore = await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_UPDATED' } });
  const c = await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(c.body.data, { imported: 0, skipped: 0, updated: 2 });

  const one = await prisma.candidate.findFirstOrThrow({ where: { email: 'upd1@iitg.ac.in' } });
  assert.equal(one.jobRoleId, roleId);
  assert.equal(one.fullName, 'Right Name One');
  assert.equal(Number(one.majorCpi), 7.1, 'blank cell kept the stored CPI');
  assert.equal(one.candidateCode, before.candidateCode, 'same candidate, not a new one');
  assert.equal((await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_UPDATED' } })) - auditsBefore, 2);
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'CANDIDATE_UPDATED', entityId: one.id }, orderBy: { createdAt: 'desc' } });
  assert.equal((audit.metadata as Record<string, unknown>).via, 'import');
});

test('updateExisting: a candidate who already started is an error row and is not moved', async () => {
  const file = csv(['60,61,UPD003,Started Person,6.1,Analytics,B.Tech,upd3@iitg.ac.in,']);
  const first = await preview(sa, file, roleId);
  await sa.post('/api/admin/candidates/import/confirm').send({ previewId: first.body.data.previewId });
  await prisma.candidate.updateMany({ where: { email: 'upd3@iitg.ac.in' }, data: { status: 'SUBMITTED' } });

  const p = await sa
    .post('/api/admin/candidates/import/preview')
    .field('jobRoleId', roleId)
    .field('updateExisting', 'true')
    .attach('file', file, 'c.csv');
  assert.equal(p.body.data.summary.updates, 0);
  assert.deepEqual(p.body.data.errors, [
    { row: 2, field: 'email', message: 'This candidate has already started an exam and cannot be updated by import' },
  ]);
  assert.equal((await prisma.candidate.findFirstOrThrow({ where: { email: 'upd3@iitg.ac.in' } })).jobRoleId, roleId);
});

test('updateExisting: a candidate who starts between preview and confirm is skipped, not moved', async () => {
  const file = csv(['50,51,UPD004,Racing Person,5.1,Analytics,B.Tech,upd4@iitg.ac.in,']);
  const first = await preview(sa, file, roleId);
  await sa.post('/api/admin/candidates/import/confirm').send({ previewId: first.body.data.previewId });

  const p = await sa
    .post('/api/admin/candidates/import/preview')
    .field('jobRoleId', roleId)
    .field('updateExisting', 'true')
    .attach('file', file, 'c.csv');
  assert.equal(p.body.data.summary.updates, 1);
  await prisma.candidate.updateMany({ where: { email: 'upd4@iitg.ac.in' }, data: { status: 'IN_PROGRESS' } });
  const c = await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId, force: true });
  assert.deepEqual(c.body.data, { imported: 0, skipped: 1, updated: 0 });
  assert.equal((await prisma.candidate.findFirstOrThrow({ where: { email: 'upd4@iitg.ac.in' } })).jobRoleId, roleId);
});

// --- Bulk "change job role" -------------------------------------------------------

test('bulk job role: moves not-started candidates, skips started / same-role / unknown, audits each move', async () => {
  const file = csv([
    '40,41,BLK001,Bulk One,4.1,Analytics,B.Tech,blk1@iitg.ac.in,',
    '42,43,BLK002,Bulk Two,4.2,Analytics,B.Tech,blk2@iitg.ac.in,',
    '44,45,BLK003,Bulk Started,4.3,Analytics,B.Tech,blk3@iitg.ac.in,',
  ]);
  const p = await preview(sa, file, roleId);
  await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId });
  const [one, two, started] = await Promise.all(
    ['blk1@iitg.ac.in', 'blk2@iitg.ac.in', 'blk3@iitg.ac.in'].map((email) => prisma.candidate.findFirstOrThrow({ where: { email } })),
  );
  await prisma.candidate.update({ where: { id: started!.id }, data: { status: 'SUBMITTED' } });
  await prisma.candidate.update({ where: { id: two!.id }, data: { jobRoleId: role2Id } });
  const ghost = '00000000-0000-4000-8000-000000000000';

  const auditsBefore = await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_UPDATED' } });
  const res = await sa
    .post('/api/admin/candidates/bulk/job-role')
    .send({ candidateIds: [one!.id, two!.id, started!.id, ghost, one!.id], jobRoleId: role2Id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.updated, 1);
  const reasons = Object.fromEntries(res.body.data.skipped.map((s: { candidateId: string; reason: string }) => [s.candidateId, s.reason]));
  assert.deepEqual(reasons, { [two!.id]: 'SAME_ROLE', [started!.id]: 'STARTED', [ghost]: 'NOT_FOUND' });
  assert.equal(res.body.data.skipped.find((s: { candidateId: string }) => s.candidateId === started!.id).candidateCode, started!.candidateCode);

  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: one!.id } })).jobRoleId, role2Id);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: started!.id } })).jobRoleId, roleId, 'started candidate untouched');
  assert.equal((await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_UPDATED' } })) - auditsBefore, 1);
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'CANDIDATE_UPDATED', entityId: one!.id }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual(audit.metadata, { via: 'bulk', fromJobRoleId: roleId, toJobRoleId: role2Id });
});

test('bulk job role: validation, unknown role and evaluator access', async () => {
  assert.equal((await sa.post('/api/admin/candidates/bulk/job-role').send({ candidateIds: [], jobRoleId: role2Id })).status, 400);
  assert.equal((await sa.post('/api/admin/candidates/bulk/job-role').send({ candidateIds: ['nope'], jobRoleId: role2Id })).status, 400);
  const someone = await prisma.candidate.findFirstOrThrow({ select: { id: true } });
  const ghostRole = await sa
    .post('/api/admin/candidates/bulk/job-role')
    .send({ candidateIds: [someone.id], jobRoleId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(ghostRole.status, 404);
  assert.equal((await ev.post('/api/admin/candidates/bulk/job-role').send({ candidateIds: [someone.id], jobRoleId: role2Id })).status, 403);
});

test('list search also matches mobile', async () => {
  const p = await preview(sa, csv(['30,31,SRCH001,Search By Mobile,3.1,Analytics,B.Tech,srch1@iitg.ac.in,']), roleId);
  await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId });
  await prisma.candidateAccount.update({ where: { email: 'srch1@iitg.ac.in' }, data: { mobile: '9812345670' } });
  await prisma.candidate.updateMany({ where: { email: 'srch1@iitg.ac.in' }, data: { mobile: '9812345670' } });
  const res = await sa.get('/api/admin/candidates?search=98123456');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.items.map((c: { email: string }) => c.email), ['s****1@iitg.ac.in']);
});

// --- Several roles per person (docs/multi-exam.md) --------------------------------

const importFile = async (file: Buffer, jobRoleId: string, force = false) => {
  const p = await preview(sa, file, jobRoleId);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return { p, confirm: () => sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId, force }) };
};

test('import: the same email under a second role links to the existing account (previewed in linkedRows); the same role again is a duplicate', async () => {
  const row = (name: string) => `60,61,MR001,${name},6.1,Analytics,B.Tech,multi@iitg.ac.in,`;
  const first = await importFile(csv([row('Multi Person')]), roleId);
  assert.deepEqual(first.p.body.data.linkedRows, []);
  assert.equal((await first.confirm()).status, 200);
  const account = await prisma.candidateAccount.findUniqueOrThrow({ where: { email: 'multi@iitg.ac.in' } });

  const second = await importFile(csv([row('Multi Person')]), role2Id);
  assert.deepEqual(second.p.body.data.summary, { total: 1, valid: 1, errors: 0, duplicates: 0 });
  assert.deepEqual(second.p.body.data.linkedRows, [2]);
  const done = await second.confirm();
  assert.deepEqual(done.body.data, { imported: 1, skipped: 0 });
  const apps = await prisma.candidate.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(apps.length, 2);
  assert.deepEqual(apps.map((a) => a.jobRoleId).sort(), [roleId, role2Id].sort());
  assert.notEqual(apps[0]!.candidateCode, apps[1]!.candidateCode);
  assert.equal(await prisma.candidateAccount.count({ where: { email: 'multi@iitg.ac.in' } }), 1);

  const dup = await importFile(csv([row('Multi Person')]), role2Id);
  assert.deepEqual(dup.p.body.data.summary, { total: 1, valid: 0, errors: 0, duplicates: 1 });
  assert.deepEqual(dup.p.body.data.duplicates, [{ row: 2, reason: 'EXISTS' }]);

  const twice = (name: string) => row(name).replace('multi@', 'twice@');
  const inFile = await importFile(csv([twice('Twice A'), twice('Twice B')]), roleId);
  assert.deepEqual(inFile.p.body.data.duplicates, [{ row: 3, reason: 'IN_FILE' }]);
  const twoRoles = Buffer.from(['name,email,job_role', 'Both Roles,both@iitg.ac.in,C Role', 'Both Roles,both@iitg.ac.in,C Role Two'].join('\n'));
  const bothRoles = await importFile(twoRoles, roleId);
  assert.deepEqual(bothRoles.p.body.data.summary, { total: 2, valid: 2, errors: 0, duplicates: 0 });
  await bothRoles.confirm();
  assert.equal(await prisma.candidateAccount.count({ where: { email: 'both@iitg.ac.in' } }), 1);
  assert.equal(await prisma.candidate.count({ where: { email: 'both@iitg.ac.in' } }), 2);
});

test('import: linking with a mobile owned by another account is an error row', async () => {
  const seed = Buffer.from(['name,email,mobile', 'Owner One,owner@iitg.ac.in,9811111111', 'Link Two,linker@iitg.ac.in,'].join('\n'));
  await (await importFile(seed, roleId)).confirm();
  const clash = Buffer.from(['name,email,mobile', 'Link Two,linker@iitg.ac.in,9811111111'].join('\n'));
  const p = await importFile(clash, role2Id);
  assert.equal(p.p.body.data.summary.valid, 0);
  assert.deepEqual(p.p.body.data.errors.map((e: { row: number; field: string }) => [e.row, e.field]), [[2, 'mobile']]);
});

test('detail lists the same person\'s other applications; a mobile edit changes the account and every application', async () => {
  const apps = await prisma.candidate.findMany({ where: { email: 'multi@iitg.ac.in' }, include: { jobRole: true } });
  const [a, b] = apps;
  const d = await sa.get(`/api/admin/candidates/${a!.id}`);
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.data.otherApplications, [
    { id: b!.id, candidateCode: b!.candidateCode, jobRole: { id: b!.jobRoleId, name: b!.jobRole.name }, status: 'NOT_STARTED', result: null },
  ]);

  const e = await sa.patch(`/api/admin/candidates/${a!.id}`).send({ mobile: '9822222222' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal((await prisma.candidateAccount.findUniqueOrThrow({ where: { id: a!.accountId } })).mobile, '9822222222');
  assert.deepEqual((await prisma.candidate.findMany({ where: { accountId: a!.accountId } })).map((x) => x.mobile), ['9822222222', '9822222222']);
});

test('add candidate: an email that has an account attaches to it; the same role again, or a different mobile, is 409', async () => {
  const body = { fullName: 'Multi Person', email: 'multi@iitg.ac.in', jobRoleId: roleId };
  const third = await prisma.jobRole.create({ data: { name: 'C Role Three', examSetting: { create: {} } } });
  const ok = await sa.post('/api/admin/candidates').send({ ...body, jobRoleId: third.id });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.mobile, '98******22', 'the application carries the account mobile (masked in the reply)');
  assert.equal((await sa.post('/api/admin/candidates').send({ ...body, jobRoleId: third.id })).status, 409);
  assert.equal((await sa.post('/api/admin/candidates').send({ ...body, jobRoleId: third.id, mobile: '9833333333' })).status, 409);
});

test('bulk job role: refuses a row whose account already holds the target role (SAME_PERSON_HAS_ROLE)', async () => {
  const [a] = await prisma.candidate.findMany({ where: { email: 'multi@iitg.ac.in', jobRoleId: roleId } });
  const res = await sa.post('/api/admin/candidates/bulk/job-role').send({ candidateIds: [a!.id], jobRoleId: role2Id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.updated, 0);
  assert.deepEqual(res.body.data.skipped.map((s: { reason: string }) => s.reason), ['SAME_PERSON_HAS_ROLE']);
  assert.equal((await sa.patch(`/api/admin/candidates/${a!.id}`).send({ jobRoleId: role2Id })).status, 409);
});

test('disabling an application revokes the sessions of its account', async () => {
  const [a] = await prisma.candidate.findMany({ where: { email: 'multi@iitg.ac.in' } });
  assert.equal((await sa.patch(`/api/admin/candidates/${a!.id}/eligibility`).send({ eligible: false })).status, 200);
  assert.notEqual(await getSessionsValidAfter('candidate', a!.accountId), null);
});

// ---- list: result, min filters, exam stats, attempt sorts, matching ids (2026-11-05) ----

type ListItem = {
  id: string;
  candidateCode: string;
  result: string | null;
  exam: { startedAt: string; submittedAt: string | null; answeredCount: number; questionCount: number; totalMarks: number | null; maxMarks: number; percentage: number | null } | null;
  otherApplications: { jobRoleName: string; status: string; result: string | null }[];
};

let listFixture: Promise<{ roleId: string; ids: Record<string, string> }> | null = null;

/** Six candidates in their own job profile; A..F described inline. */
function fixture() {
  listFixture ??= (async () => {
    const role = await prisma.jobRole.create({ data: { name: 'List Role', examSetting: { create: {} } } });
    const qs = await Promise.all(
      [1, 2].map((n) => prisma.question.create({ data: { jobRoleId: role.id, text: `L${n}`, normalizedTextHash: `list-${n}`, maxMarks: 10 } })),
    );
    const ids: Record<string, string> = {};
    const t0 = new Date('2026-11-04T05:00:00Z').getTime();
    const mk = async (
      key: string,
      c: { x: number | null; xii: number | null; cpi: number | null; status: 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'EVALUATED'; result?: 'SHORTLISTED' | 'REJECTED' },
      a?: { minutes: number | null; answered: number; marks?: number; reset?: boolean },
    ) => {
      const cand = await createCandidate({
        candidateCode: `LST-${key}`,
        fullName: `List ${key}`,
        email: `list-${key.toLowerCase()}@iitg.ac.in`,
        jobRoleId: role.id,
        xPercentage: c.x,
        xiiPercentage: c.xii,
        majorCpi: c.cpi,
        status: c.status,
        result: c.result ?? null,
      });
      ids[key] = cand.id;
      if (!a) return;
      const evaluated = a.marks !== undefined && !a.reset;
      await prisma.examAttempt.create({
        data: {
          candidateId: cand.id,
          status: a.reset ? 'RESET' : a.minutes === null ? 'IN_PROGRESS' : 'SUBMITTED',
          startedAt: new Date(t0),
          endsAt: new Date(t0 + 60 * 60_000),
          submittedAt: a.minutes === null ? null : new Date(t0 + a.minutes * 60_000),
          activeSessionId: 's',
          startIp: '1.1.1.1',
          userAgent: 'ua',
          maxMarks: 20,
          totalMarks: a.marks ?? null,
          percentage: a.marks === undefined ? null : a.marks * 5,
          questions: {
            create: qs.map((q, i) => ({
              questionId: q.id,
              order: i + 1,
              textSnapshot: q.text,
              maxMarksSnapshot: 10,
              answer: { create: { text: i < a.answered ? 'some words here' : '', wordCount: i < a.answered ? 3 : 0 } },
            })),
          },
          ...(evaluated ? { evaluation: { create: { status: 'SUBMITTED', submittedAt: new Date() } } } : {}),
        },
      });
    };
    await mk('A', { x: 90, xii: 85, cpi: 8, status: 'EVALUATED', result: 'SHORTLISTED' }, { minutes: 30, answered: 2, marks: 16 }); // 80 %
    await mk('B', { x: 70, xii: 95, cpi: 7, status: 'EVALUATED', result: 'REJECTED' }, { minutes: 10, answered: 1, marks: 10 }); // 50 %
    await mk('C', { x: null, xii: 60, cpi: null, status: 'SUBMITTED' }, { minutes: 20, answered: 2 }); // not evaluated
    await mk('D', { x: 80, xii: 80, cpi: 9, status: 'NOT_STARTED' });
    await mk('E', { x: 85, xii: null, cpi: 8.5, status: 'NOT_STARTED' }, { minutes: 5, answered: 2, marks: 18, reset: true }); // reset 90 %
    await mk('F', { x: 60, xii: 70, cpi: 6, status: 'IN_PROGRESS' }, { minutes: null, answered: 1 });
    return { roleId: role.id, ids };
  })();
  return listFixture;
}

async function listCodes(query: string): Promise<string[]> {
  const { roleId: lr } = await fixture();
  const res = await sa.get(`/api/admin/candidates?jobRoleId=${lr}&pageSize=100&${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body.data.items as ListItem[]).map((i) => i.candidateCode.replace('LST-', ''));
}

test('result filter: SHORTLISTED, REJECTED, NONE', async () => {
  assert.deepEqual(await listCodes('result=SHORTLISTED'), ['A']);
  assert.deepEqual(await listCodes('result=REJECTED'), ['B']);
  assert.deepEqual((await listCodes('result=NONE&sort=fullName&dir=asc')), ['C', 'D', 'E', 'F']);
  assert.equal((await sa.get('/api/admin/candidates?result=MAYBE')).status, 400);
});

test('min filters combine; cpiMin=0 excludes null CPI', async () => {
  const asc = 'sort=fullName&dir=asc';
  assert.deepEqual(await listCodes(`xMin=80&${asc}`), ['A', 'D', 'E']);
  assert.deepEqual(await listCodes(`cpiMin=0&${asc}`), ['A', 'B', 'D', 'E', 'F']);
  assert.deepEqual(await listCodes(`xiiMin=90&${asc}`), ['B']);
  assert.deepEqual(await listCodes(`xMin=80&cpiMin=8.5&${asc}`), ['D', 'E']);
  assert.equal((await sa.get('/api/admin/candidates?cpiMin=11')).status, 400);
});

test('marksPctMin ignores reset attempts and unevaluated ones', async () => {
  assert.deepEqual(await listCodes('marksPctMin=60'), ['A']);
  assert.deepEqual(await listCodes('marksPctMin=0&sort=fullName&dir=asc'), ['A', 'B']);
});

test('sort=marks desc: highest % first, unevaluated last; asc also puts empty last; ties by id', async () => {
  const { ids } = await fixture();
  const rest = ['C', 'D', 'E', 'F'].sort((a, b) => (ids[a]! < ids[b]! ? -1 : 1));
  assert.deepEqual(await listCodes('sort=marks&dir=desc'), ['A', 'B', ...rest]);
  assert.deepEqual(await listCodes('sort=marks&dir=asc'), ['B', 'A', ...rest]);
});

test('sort=timeTaken asc: shortest first, unsubmitted last; pagination is stable across pages', async () => {
  const { roleId: lr, ids } = await fixture();
  const rest = ['D', 'E', 'F'].sort((a, b) => (ids[a]! < ids[b]! ? -1 : 1));
  const all = await listCodes('sort=timeTaken&dir=asc');
  assert.deepEqual(all, ['B', 'C', 'A', ...rest]);
  assert.deepEqual(await listCodes('sort=timeTaken&dir=desc'), ['A', 'C', 'B', ...rest]);
  const paged: string[] = [];
  for (const page of [1, 2, 3]) {
    const res = await sa.get(`/api/admin/candidates?jobRoleId=${lr}&sort=timeTaken&dir=asc&pageSize=2&page=${page}`);
    assert.equal(res.body.data.total, 6);
    paged.push(...(res.body.data.items as ListItem[]).map((i) => i.candidateCode.replace('LST-', '')));
  }
  assert.deepEqual(paged, all);
});

test('list item exam stats: answered/question counts, marks null until evaluation submitted', async () => {
  const { roleId: lr } = await fixture();
  const res = await sa.get(`/api/admin/candidates?jobRoleId=${lr}&pageSize=100`);
  const by = new Map((res.body.data.items as ListItem[]).map((i) => [i.candidateCode.replace('LST-', ''), i]));
  assert.deepEqual(by.get('A')!.exam, {
    startedAt: '2026-11-04T05:00:00.000Z',
    submittedAt: '2026-11-04T05:30:00.000Z',
    answeredCount: 2,
    questionCount: 2,
    totalMarks: 16,
    maxMarks: 20,
    percentage: 80,
  });
  assert.equal(by.get('A')!.result, 'SHORTLISTED');
  assert.deepEqual({ ...by.get('C')!.exam, startedAt: undefined, submittedAt: undefined }, { startedAt: undefined, submittedAt: undefined, answeredCount: 2, questionCount: 2, totalMarks: null, maxMarks: 20, percentage: null });
  assert.equal(by.get('D')!.exam, null);
  assert.equal(by.get('E')!.exam, null, 'a reset attempt is not the current one');
  assert.equal(by.get('F')!.exam!.submittedAt, null);
  assert.equal(by.get('F')!.exam!.answeredCount, 1);
});

test('otherApplications: both applications of one person on the same page list each other with result', async () => {
  const { roleId: lr } = await fixture();
  const p = await createCandidate({ candidateCode: 'LST-P1', fullName: 'List Twin', email: 'list-twin@iitg.ac.in', jobRoleId: lr, status: 'EVALUATED', result: 'REJECTED' });
  await createApplication(p.accountId, { candidateCode: 'LST-P2', fullName: 'List Twin', jobRoleId: role2Id });
  const res = await sa.get('/api/admin/candidates?search=List%20Twin&pageSize=100');
  const by = new Map((res.body.data.items as ListItem[]).map((i) => [i.candidateCode, i]));
  assert.equal(by.size, 2);
  assert.deepEqual(by.get('LST-P1')!.otherApplications, [{ jobRoleName: 'C Role Two', status: 'NOT_STARTED', result: null }]);
  assert.deepEqual(by.get('LST-P2')!.otherApplications, [{ jobRoleName: 'List Role', status: 'EVALUATED', result: 'REJECTED' }]);
  await prisma.candidate.deleteMany({ where: { accountId: p.accountId } });
  await prisma.candidateAccount.delete({ where: { id: p.accountId } });
});

test('GET /ids returns all matching ids (with jobRoleIdById) across pages; >1000 → 400; evaluator → 403', async () => {
  const { roleId: lr, ids } = await fixture();
  const res = await sa.get(`/api/admin/candidates/ids?jobRoleId=${lr}&cpiMin=0&pageSize=2`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.total, 5);
  assert.deepEqual([...res.body.data.ids].sort(), ['A', 'B', 'D', 'E', 'F'].map((k) => ids[k]!).sort());
  assert.ok(res.body.data.ids.every((id: string) => res.body.data.jobRoleIdById[id] === lr));
  assert.equal((await ev.get(`/api/admin/candidates/ids?jobRoleId=${lr}`)).status, 403);

  const bulkRole = await prisma.jobRole.create({ data: { name: 'List Bulk Role' } });
  await createCandidates(
    Array.from({ length: 1001 }, (_, i) => ({ candidateCode: `LSTB-${i}`, fullName: `Bulk ${i}`, email: `lstb-${i}@iitg.ac.in`, jobRoleId: bulkRole.id })),
  );
  const big = await sa.get(`/api/admin/candidates/ids?jobRoleId=${bulkRole.id}`);
  assert.equal(big.status, 400);
  assert.match(big.body.error.message, /More than 1000 candidates match/);
});

// ---- masked email / mobile (2026-11-05) ---------------------------------------

test('list and detail mask email and mobile; search still matches the full values', async () => {
  const c = await createCandidate({ candidateCode: 'MSK-1', fullName: 'Mask Person', email: 'mask.person@iitg.ac.in', mobile: '9123456780', jobRoleId: roleId });
  const list = await sa.get('/api/admin/candidates?search=mask.person%40iitg.ac.in');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.data.total, 1);
  assert.equal(list.body.data.items[0].email, 'm****n@iitg.ac.in');
  assert.equal(list.body.data.items[0].mobile, '91******80');
  assert.equal((await sa.get('/api/admin/candidates?search=9123456780')).body.data.total, 1);
  const d = await sa.get(`/api/admin/candidates/${c.id}`);
  assert.equal(d.body.data.candidate.email, 'm****n@iitg.ac.in');
  assert.equal(d.body.data.candidate.mobile, '91******80');
  assert.ok(!JSON.stringify(d.body).includes('mask.person@'), 'no full email anywhere in the detail payload');
  assert.ok(!JSON.stringify(d.body).includes('9123456780'), 'no full mobile anywhere in the detail payload');
});

test('GET /:id/contact reveals the full email and mobile to a Super Admin, audited; evaluator is 403', async () => {
  const c = await prisma.candidate.findUniqueOrThrow({ where: { candidateCode: 'MSK-1' } });
  const r = await sa.get(`/api/admin/candidates/${c.id}/contact`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { email: 'mask.person@iitg.ac.in', mobile: '9123456780' });
  const audit = await prisma.adminAuditLog.findMany({ where: { action: 'CANDIDATE_CONTACT_REVEALED', entityId: c.id } });
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit[0]!.metadata ?? {}).includes('mask.person'), 'the audit row does not copy the PII');
  assert.equal((await ev.get(`/api/admin/candidates/${c.id}/contact`)).status, 403);
  assert.equal((await sa.get(`/api/admin/candidates/${crypto.randomUUID()}/contact`)).status, 404);
});

test('saving a masked email back is refused; editing other fields without email/mobile keeps them', async () => {
  const c = await prisma.candidate.findUniqueOrThrow({ where: { candidateCode: 'MSK-1' } });
  const bad = await sa.patch(`/api/admin/candidates/${c.id}`).send({ email: 'm****n@iitg.ac.in' });
  assert.equal(bad.status, 400);
  const ok = await sa.patch(`/api/admin/candidates/${c.id}`).send({ fullName: 'Mask Person Two' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = await prisma.candidate.findUniqueOrThrow({ where: { id: c.id } });
  assert.deepEqual({ email: row.email, mobile: row.mobile, name: row.fullName }, { email: 'mask.person@iitg.ac.in', mobile: '9123456780', name: 'Mask Person Two' });
});
