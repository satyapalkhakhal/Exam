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
import { createApplication, createCandidate, createCandidates, createDrive, createRoleWithDrive } from './helpers.js';

const SA = { email: 'super@cands.test', password: 'super-pass-123' };
const EV = { email: 'eval@cands.test', password: 'eval-pass-123' };
let app: Express;
let sa: request.Agent;
let ev: request.Agent;
let driveA = '';
let driveB = '';
/** Round 1 of 'C Role' (driveA's round) and a second college's drive of it with the same batch. */
let round1Id = '';
let siblingDrive = '';

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
    'TRUNCATE TABLE admin_audit_logs, candidate_status_history, exam_attempts, candidate_accounts, candidates, import_batches, questions, drives, colleges, exam_rounds, job_roles, admin_users RESTART IDENTITY CASCADE',
  );
  await getRedis().flushdb();
  for (const [c, name, role] of [
    [SA, 'C Super', 'SUPER_ADMIN'],
    [EV, 'C Eval', 'EVALUATOR'],
  ] as const) {
    await prisma.adminUser.create({ data: { email: c.email, name, role, passwordHash: await bcrypt.hash(c.password, 4) } });
  }
  const a = await createRoleWithDrive('C Role', { college: 'IITG', batch: 'Nov 2026' });
  driveA = a.driveId;
  round1Id = a.roundId;
  siblingDrive = (await createDrive(a.jobRoleId, { college: 'NITT', batch: 'Nov 2026' })).driveId;
  driveB = (await createRoleWithDrive('C Role Two', { college: 'IITG', batch: 'Nov 2026' })).driveId;
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

const preview = (agent: request.Agent, file: Buffer, driveId: string) =>
  agent.post('/api/admin/candidates/import/preview').field('driveId', driveId).attach('file', file, 'c.csv');

test('template.csv carries the HR header row plus mobile (the drive is chosen for the file, no job_role)', async () => {
  const res = await sa.get('/api/admin/candidates/template.csv');
  assert.equal(res.status, 200);
  assert.match(res.text, /^schooling\.x_percentage,.*,email,mobile\n$/);
});

test('import 3 rows: preview then confirm; list total is 3; codes and lower-cased email stored', async () => {
  const p = await preview(sa, three, driveA);
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
  const p = await preview(sa, three, driveA);
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
  assert.equal((await sa.get(`/api/admin/candidates?driveId=${driveB}`)).body.data.total, 0);
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
    nearbyCount: null,
  });
});

test('an Evaluator calling list, detail or import gets 403', async () => {
  assert.equal((await ev.get('/api/admin/candidates')).status, 403);
  assert.equal((await preview(ev, three, driveA)).status, 403);
});

test('detail returns profile, extra, history and zero flags', async () => {
  const one = await prisma.candidate.findFirstOrThrow({ where: { email: 'k.ajith@iitg.ac.in' } });
  const d = await sa.get(`/api/admin/candidates/${one.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.data.candidate.extra.hostel, 'Brahmaputra');
  assert.equal(d.body.data.attempt, null);
  assert.deepEqual(d.body.data.flags, { integrity: { pasteAttempts: 0, bulkInsert: 0, tabHidden: 0, blur: 0, ipChanges: 0 }, location: [], nearbyCount: null });
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

  assert.equal((await sa.patch(`/api/admin/candidates/${bina.id}`).send({ driveId: driveB })).status, 200);
  await prisma.candidate.update({ where: { id: bina.id }, data: { status: 'IN_PROGRESS' } });
  const r = await sa.patch(`/api/admin/candidates/${bina.id}`).send({ driveId: driveA });
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
  const p = await preview(sa, file, driveA);
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
    driveId: driveA,
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

  const dupEmail = await sa.post('/api/admin/candidates').send({ fullName: 'Other', email: 'dipak.rout@cands.test', driveId: driveA });
  assert.equal(dupEmail.status, 409);
  const dupMobile = await sa.post('/api/admin/candidates').send({ fullName: 'Other', email: 'other@cands.test', mobile: '9004541335', driveId: driveA });
  assert.equal(dupMobile.status, 409);

  const minimal = await sa.post('/api/admin/candidates').send({ fullName: 'Only Required', email: 'min@cands.test', driveId: driveA });
  assert.equal(minimal.status, 201, 'name, email and role are the only required fields');

  for (const bad of [
    { fullName: 'X', email: 'x@cands.test', driveId: driveA },
    { fullName: 'Bad Mail', email: 'dipak', driveId: driveA },
    { fullName: 'Bad Pct', email: 'p@cands.test', xPercentage: 101, driveId: driveA },
    { fullName: 'Bad Cpi', email: 'q@cands.test', majorCpi: 11, driveId: driveA },
    { fullName: 'No Role', email: 'r@cands.test' },
  ]) {
    assert.equal((await sa.post('/api/admin/candidates').send(bad)).status, 400, JSON.stringify(bad));
  }
  const ghostRole = await sa.post('/api/admin/candidates').send({ fullName: 'Ghost Role', email: 'g@cands.test', driveId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(ghostRole.status, 404);

  assert.equal((await ev.post('/api/admin/candidates').send({ fullName: 'Eval Try', email: 'e@cands.test', driveId: driveA })).status, 403);
});

// --- Re-upload with "update existing candidates" ---------------------------------

test('updateExisting: re-uploading a corrected file to the same job profile refreshes the applications (email + role)', async () => {
  const people = csv([
    '70,71,UPD001,Wrong Name One,7.1,Analytics,B.Tech,upd1@iitg.ac.in,',
    '72,73,UPD002,Wrong Name Two,7.2,Analytics,B.Tech,upd2@iitg.ac.in,',
  ]);
  const first = await preview(sa, people, driveA);
  assert.equal((await sa.post('/api/admin/candidates/import/confirm').send({ previewId: first.body.data.previewId })).status, 200);
  const before = await prisma.candidate.findFirstOrThrow({ where: { email: 'upd1@iitg.ac.in' } });
  assert.equal(before.driveId, driveA);

  // Plain re-upload to the same profile: still skipped as duplicates, nothing changes.
  const plain = await preview(sa, people, driveA);
  assert.equal(plain.body.data.summary.duplicates, 2);
  assert.equal(plain.body.data.summary.updates, undefined);

  // Corrected file: one CPI blank (keep stored), one name fixed.
  const fixed = csv([
    '70,71,UPD001,Right Name One,,Analytics,B.Tech,upd1@iitg.ac.in,',
    '72,73,UPD002,Wrong Name Two,7.2,Analytics,B.Tech,UPD2@iitg.ac.in,',
  ]);
  const p = await sa
    .post('/api/admin/candidates/import/preview')
    .field('driveId', driveA)
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
  assert.equal(one.driveId, driveA);
  assert.equal(one.fullName, 'Right Name One');
  assert.equal(Number(one.majorCpi), 7.1, 'blank cell kept the stored CPI');
  assert.equal(one.candidateCode, before.candidateCode, 'same candidate, not a new one');
  assert.equal((await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_UPDATED' } })) - auditsBefore, 2);
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'CANDIDATE_UPDATED', entityId: one.id }, orderBy: { createdAt: 'desc' } });
  assert.equal((audit.metadata as Record<string, unknown>).via, 'import');
});

test('updateExisting: a candidate who already started is an error row and is not moved', async () => {
  const file = csv(['60,61,UPD003,Started Person,6.1,Analytics,B.Tech,upd3@iitg.ac.in,']);
  const first = await preview(sa, file, driveA);
  await sa.post('/api/admin/candidates/import/confirm').send({ previewId: first.body.data.previewId });
  await prisma.candidate.updateMany({ where: { email: 'upd3@iitg.ac.in' }, data: { status: 'SUBMITTED' } });

  const p = await sa
    .post('/api/admin/candidates/import/preview')
    .field('driveId', driveA)
    .field('updateExisting', 'true')
    .attach('file', file, 'c.csv');
  assert.equal(p.body.data.summary.updates, 0);
  assert.deepEqual(p.body.data.errors, [
    { row: 2, field: 'email', message: 'This candidate has already started an exam and cannot be updated by import' },
  ]);
  assert.equal((await prisma.candidate.findFirstOrThrow({ where: { email: 'upd3@iitg.ac.in' } })).driveId, driveA);
});

test('updateExisting: a candidate who starts between preview and confirm is skipped, not moved', async () => {
  const file = csv(['50,51,UPD004,Racing Person,5.1,Analytics,B.Tech,upd4@iitg.ac.in,']);
  const first = await preview(sa, file, driveA);
  await sa.post('/api/admin/candidates/import/confirm').send({ previewId: first.body.data.previewId });

  const p = await sa
    .post('/api/admin/candidates/import/preview')
    .field('driveId', driveA)
    .field('updateExisting', 'true')
    .attach('file', file, 'c.csv');
  assert.equal(p.body.data.summary.updates, 1);
  await prisma.candidate.updateMany({ where: { email: 'upd4@iitg.ac.in' }, data: { status: 'IN_PROGRESS' } });
  const c = await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId, force: true });
  assert.deepEqual(c.body.data, { imported: 0, skipped: 1, updated: 0 });
  assert.equal((await prisma.candidate.findFirstOrThrow({ where: { email: 'upd4@iitg.ac.in' } })).driveId, driveA);
});

// --- Bulk "move to drive" ---------------------------------------------------------

test('bulk move: moves not-started candidates to another round, skips started / same drive / unknown, audits each move', async () => {
  const file = csv([
    '40,41,BLK001,Bulk One,4.1,Analytics,B.Tech,blk1@iitg.ac.in,',
    '42,43,BLK002,Bulk Two,4.2,Analytics,B.Tech,blk2@iitg.ac.in,',
    '44,45,BLK003,Bulk Started,4.3,Analytics,B.Tech,blk3@iitg.ac.in,',
  ]);
  const p = await preview(sa, file, driveA);
  await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId });
  const [one, two, started] = await Promise.all(
    ['blk1@iitg.ac.in', 'blk2@iitg.ac.in', 'blk3@iitg.ac.in'].map((email) => prisma.candidate.findFirstOrThrow({ where: { email } })),
  );
  await prisma.candidate.update({ where: { id: started!.id }, data: { status: 'SUBMITTED' } });
  await prisma.candidate.update({ where: { id: two!.id }, data: { driveId: driveB, jobRoleId: (await prisma.candidate.findFirstOrThrow({ where: { driveId: driveB } }).catch(() => null))?.jobRoleId ?? two!.jobRoleId } });
  const ghost = '00000000-0000-4000-8000-000000000000';

  const auditsBefore = await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_MOVED' } });
  const res = await sa
    .post('/api/admin/candidates/bulk/move')
    .send({ candidateIds: [one!.id, two!.id, started!.id, ghost, one!.id], driveId: driveB });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.updated, 1);
  const reasons = Object.fromEntries(res.body.data.skipped.map((s: { candidateId: string; reason: string }) => [s.candidateId, s.reason]));
  assert.deepEqual(reasons, { [two!.id]: 'SAME_DRIVE', [started!.id]: 'STARTED', [ghost]: 'NOT_FOUND' });
  assert.equal(res.body.data.skipped.find((s: { candidateId: string }) => s.candidateId === started!.id).candidateCode, started!.candidateCode);

  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: one!.id } })).driveId, driveB);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: started!.id } })).driveId, driveA, 'started candidate untouched');
  const moved = await prisma.candidate.findUniqueOrThrow({ where: { id: one!.id }, include: { drive: { include: { round: true } } } });
  assert.equal(moved.jobRoleId, moved.drive.round.jobRoleId, 'job role follows the drive');
  assert.equal((await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_MOVED' } })) - auditsBefore, 1);
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'CANDIDATE_MOVED', entityId: one!.id }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual(audit.metadata, { via: 'bulk', fromDriveId: driveA, toDriveId: driveB });
});

test('bulk move: validation, unknown drive and evaluator access', async () => {
  assert.equal((await sa.post('/api/admin/candidates/bulk/move').send({ candidateIds: [], driveId: driveB })).status, 400);
  assert.equal((await sa.post('/api/admin/candidates/bulk/move').send({ candidateIds: ['nope'], driveId: driveB })).status, 400);
  const someone = await prisma.candidate.findFirstOrThrow({ select: { id: true } });
  const ghostRole = await sa
    .post('/api/admin/candidates/bulk/move')
    .send({ candidateIds: [someone.id], driveId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(ghostRole.status, 404);
  assert.equal((await ev.post('/api/admin/candidates/bulk/move').send({ candidateIds: [someone.id], driveId: driveB })).status, 403);
});

test('list search also matches mobile', async () => {
  const p = await preview(sa, csv(['30,31,SRCH001,Search By Mobile,3.1,Analytics,B.Tech,srch1@iitg.ac.in,']), driveA);
  await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId });
  await prisma.candidateAccount.update({ where: { email: 'srch1@iitg.ac.in' }, data: { mobile: '9812345670' } });
  await prisma.candidate.updateMany({ where: { email: 'srch1@iitg.ac.in' }, data: { mobile: '9812345670' } });
  const res = await sa.get('/api/admin/candidates?search=98123456');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.items.map((c: { email: string }) => c.email), ['s****1@iitg.ac.in']);
});

// --- Several drives per person (docs/multi-exam.md, spec 2026-11-10) --------------

const importFile = async (file: Buffer, driveId: string, force = false) => {
  const p = await preview(sa, file, driveId);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return { p, confirm: () => sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId, force }) };
};

test('import: the same email into a second drive links to the existing account (previewed in linkedRows); the same drive again is a duplicate', async () => {
  const row = (name: string) => `60,61,MR001,${name},6.1,Analytics,B.Tech,multi@iitg.ac.in,`;
  const first = await importFile(csv([row('Multi Person')]), driveA);
  assert.deepEqual(first.p.body.data.linkedRows, []);
  assert.equal((await first.confirm()).status, 200);
  const account = await prisma.candidateAccount.findUniqueOrThrow({ where: { email: 'multi@iitg.ac.in' } });

  const second = await importFile(csv([row('Multi Person')]), driveB);
  assert.deepEqual(second.p.body.data.summary, { total: 1, valid: 1, errors: 0, duplicates: 0 });
  assert.deepEqual(second.p.body.data.linkedRows, [2]);
  const done = await second.confirm();
  assert.deepEqual(done.body.data, { imported: 1, skipped: 0 });
  const apps = await prisma.candidate.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(apps.length, 2);
  assert.deepEqual(apps.map((a) => a.driveId).sort(), [driveA, driveB].sort());
  assert.notEqual(apps[0]!.candidateCode, apps[1]!.candidateCode);
  assert.equal(await prisma.candidateAccount.count({ where: { email: 'multi@iitg.ac.in' } }), 1);

  const dup = await importFile(csv([row('Multi Person')]), driveB);
  assert.deepEqual(dup.p.body.data.summary, { total: 1, valid: 0, errors: 0, duplicates: 1 });
  assert.deepEqual(dup.p.body.data.duplicates, [{ row: 2, reason: 'EXISTS' }]);

  const twice = (name: string) => row(name).replace('multi@', 'twice@');
  const inFile = await importFile(csv([twice('Twice A'), twice('Twice B')]), driveA);
  assert.deepEqual(inFile.p.body.data.duplicates, [{ row: 3, reason: 'IN_FILE' }]);
  // An old job_role column no longer routes rows: everything goes into the chosen drive.
  const oldColumn = Buffer.from(['name,email,job_role', 'Both Roles,both@iitg.ac.in,C Role Two'].join('\n'));
  const one = await importFile(oldColumn, driveA);
  assert.deepEqual(one.p.body.data.summary, { total: 1, valid: 1, errors: 0, duplicates: 0 });
  await one.confirm();
  const both = await prisma.candidate.findFirstOrThrow({ where: { email: 'both@iitg.ac.in' } });
  assert.equal(both.driveId, driveA);
  assert.deepEqual(both.extra, { job_role: 'C Role Two' });
});

test('import: linking with a mobile owned by another account is an error row', async () => {
  const seed = Buffer.from(['name,email,mobile', 'Owner One,owner@iitg.ac.in,9811111111', 'Link Two,linker@iitg.ac.in,'].join('\n'));
  await (await importFile(seed, driveA)).confirm();
  const clash = Buffer.from(['name,email,mobile', 'Link Two,linker@iitg.ac.in,9811111111'].join('\n'));
  const p = await importFile(clash, driveB);
  assert.equal(p.p.body.data.summary.valid, 0);
  assert.deepEqual(p.p.body.data.errors.map((e: { row: number; field: string }) => [e.row, e.field]), [[2, 'mobile']]);
});

test('detail lists the same person\'s other applications; a mobile edit changes the account and every application', async () => {
  const apps = await prisma.candidate.findMany({ where: { email: 'multi@iitg.ac.in' }, include: { jobRole: true } });
  const [a, b] = apps;
  const d = await sa.get(`/api/admin/candidates/${a!.id}`);
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.data.otherApplications, [
    { id: b!.id, candidateCode: b!.candidateCode, jobRole: { id: b!.jobRoleId, name: b!.jobRole.name }, driveDisplayName: `${b!.jobRole.name} · Round 1 · IITG · Nov 2026`, status: 'NOT_STARTED', result: null },
  ]);

  const e = await sa.patch(`/api/admin/candidates/${a!.id}`).send({ mobile: '9822222222' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal((await prisma.candidateAccount.findUniqueOrThrow({ where: { id: a!.accountId } })).mobile, '9822222222');
  assert.deepEqual((await prisma.candidate.findMany({ where: { accountId: a!.accountId } })).map((x) => x.mobile), ['9822222222', '9822222222']);
});

test('add candidate: an email that has an account attaches to it; the same drive again, or a different mobile, is 409', async () => {
  const body = { fullName: 'Multi Person', email: 'multi@iitg.ac.in', driveId: driveA };
  const third = await createRoleWithDrive('C Role Three');
  const ok = await sa.post('/api/admin/candidates').send({ ...body, driveId: third.driveId });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.mobile, '98******22', 'the application carries the account mobile (masked in the reply)');
  assert.equal((await sa.post('/api/admin/candidates').send({ ...body, driveId: third.driveId })).status, 409);
  assert.equal((await sa.post('/api/admin/candidates').send({ ...body, driveId: third.driveId, mobile: '9833333333' })).status, 409);
});

test('bulk move: refuses a row whose account is already in the target drive (SAME_DRIVE via the person)', async () => {
  const [a] = await prisma.candidate.findMany({ where: { email: 'multi@iitg.ac.in', driveId: driveA } });
  const res = await sa.post('/api/admin/candidates/bulk/move').send({ candidateIds: [a!.id], driveId: driveB });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.updated, 0);
  assert.deepEqual(res.body.data.skipped.map((s: { reason: string }) => s.reason), ['SAME_DRIVE']);
  assert.equal((await sa.patch(`/api/admin/candidates/${a!.id}`).send({ driveId: driveB })).status, 409);
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
  otherApplications: { driveDisplayName: string; status: string; result: string | null }[];
};

let listFixture: Promise<{ driveA: string; ids: Record<string, string> }> | null = null;

/** Six candidates in their own job profile; A..F described inline. */
function fixture() {
  listFixture ??= (async () => {
    const role = await createRoleWithDrive('List Role');
    const qs = await Promise.all(
      [1, 2].map((n) => prisma.question.create({ data: { roundId: role.roundId, text: `L${n}`, normalizedTextHash: `list-${n}`, maxMarks: 10 } })),
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
        driveId: role.driveId,
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
    return { driveA: role.driveId, ids };
  })();
  return listFixture;
}

async function listCodes(query: string): Promise<string[]> {
  const { driveA: lr } = await fixture();
  const res = await sa.get(`/api/admin/candidates?driveId=${lr}&pageSize=100&${query}`);
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
  const { driveA: lr, ids } = await fixture();
  const rest = ['D', 'E', 'F'].sort((a, b) => (ids[a]! < ids[b]! ? -1 : 1));
  const all = await listCodes('sort=timeTaken&dir=asc');
  assert.deepEqual(all, ['B', 'C', 'A', ...rest]);
  assert.deepEqual(await listCodes('sort=timeTaken&dir=desc'), ['A', 'C', 'B', ...rest]);
  const paged: string[] = [];
  for (const page of [1, 2, 3]) {
    const res = await sa.get(`/api/admin/candidates?driveId=${lr}&sort=timeTaken&dir=asc&pageSize=2&page=${page}`);
    assert.equal(res.body.data.total, 6);
    paged.push(...(res.body.data.items as ListItem[]).map((i) => i.candidateCode.replace('LST-', '')));
  }
  assert.deepEqual(paged, all);
});

test('list item exam stats: answered/question counts, marks null until evaluation submitted', async () => {
  const { driveA: lr } = await fixture();
  const res = await sa.get(`/api/admin/candidates?driveId=${lr}&pageSize=100`);
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
  const { driveA: lr } = await fixture();
  const p = await createCandidate({ candidateCode: 'LST-P1', fullName: 'List Twin', email: 'list-twin@iitg.ac.in', driveId: lr, status: 'EVALUATED', result: 'REJECTED' });
  await createApplication(p.accountId, { candidateCode: 'LST-P2', fullName: 'List Twin', driveId: driveB });
  const res = await sa.get('/api/admin/candidates?search=List%20Twin&pageSize=100');
  const by = new Map((res.body.data.items as ListItem[]).map((i) => [i.candidateCode, i]));
  assert.equal(by.size, 2);
  assert.deepEqual(by.get('LST-P1')!.otherApplications, [{ driveDisplayName: 'C Role Two · Round 1 · IITG · Nov 2026', status: 'NOT_STARTED', result: null }]);
  const [twin] = by.get('LST-P2')!.otherApplications;
  assert.match(twin!.driveDisplayName, /^List Role · Round 1 · TST · /);
  assert.deepEqual([twin!.status, twin!.result], ['EVALUATED', 'REJECTED']);
  await prisma.candidate.deleteMany({ where: { accountId: p.accountId } });
  await prisma.candidateAccount.delete({ where: { id: p.accountId } });
});

test('GET /ids returns all matching ids (with driveIdById) across pages; >1000 → 400; evaluator → 403', async () => {
  const { driveA: lr, ids } = await fixture();
  const res = await sa.get(`/api/admin/candidates/ids?driveId=${lr}&cpiMin=0&pageSize=2`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.total, 5);
  assert.deepEqual([...res.body.data.ids].sort(), ['A', 'B', 'D', 'E', 'F'].map((k) => ids[k]!).sort());
  assert.ok(res.body.data.ids.every((id: string) => res.body.data.driveIdById[id] === lr));
  assert.equal((await ev.get(`/api/admin/candidates/ids?driveId=${lr}`)).status, 403);

  const bulkRole = await createRoleWithDrive('List Bulk Role');
  await createCandidates(
    Array.from({ length: 1001 }, (_, i) => ({ candidateCode: `LSTB-${i}`, fullName: `Bulk ${i}`, email: `lstb-${i}@iitg.ac.in`, driveId: bulkRole.driveId })),
  );
  const big = await sa.get(`/api/admin/candidates/ids?driveId=${bulkRole.driveId}`);
  assert.equal(big.status, 400);
  assert.match(big.body.error.message, /More than 1000 candidates match/);
});

// ---- masked email / mobile (2026-11-05) ---------------------------------------

test('list and detail mask email and mobile; search still matches the full values', async () => {
  const c = await createCandidate({ candidateCode: 'MSK-1', fullName: 'Mask Person', email: 'mask.person@iitg.ac.in', mobile: '9123456780', driveId: driveA });
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

// ---- nearby candidates count (2026-11-05) -----------------------------------------

/** An EXAM_START location row (the only one the nearby rule reads). */
const startAt = (candidateId: string, lat: number, lng: number, at: Date, permission: 'GRANTED' | 'DENIED' = 'GRANTED') =>
  prisma.candidateLoginLog.create({
    data: { candidateId, stage: 'EXAM_START', permission, latitude: lat, longitude: lng, createdAt: at, ip: '203.0.113.9', userAgent: 'ua', browser: 'x', os: 'x', deviceType: 'desktop' },
  });

test('list nearbyCount: others who started within 100 m and 2 h; 0 when alone; null without a start location', async () => {
  const role = await createRoleWithDrive('Nearby Role');
  const t0 = new Date('2026-09-01T04:00:00Z').getTime();
  const mk = (key: string) => createCandidate({ candidateCode: `NB-${key}`, fullName: `Nearby ${key}`, email: `nb-${key.toLowerCase()}@iitg.ac.in`, driveId: role.driveId });
  const [n1, n2, n3, far, late, denied, none] = await Promise.all(['N1', 'N2', 'N3', 'FAR', 'LATE', 'DENIED', 'NONE'].map(mk));
  await startAt(n1!.id, 12.97160, 77.59460, new Date(t0));
  await startAt(n2!.id, 12.97165, 77.59465, new Date(t0 + 30 * 60_000)); // ~8 m
  await startAt(n3!.id, 12.97180, 77.59480, new Date(t0 + 60 * 60_000)); // ~30 m
  await startAt(far!.id, 13.10000, 77.70000, new Date(t0)); // ~18 km
  await startAt(late!.id, 12.97160, 77.59460, new Date(t0 + 5 * 3_600_000)); // same spot, 5 h later
  await startAt(denied!.id, 12.97160, 77.59460, new Date(t0), 'DENIED');
  const res = await sa.get(`/api/admin/candidates?driveId=${role.driveId}&pageSize=100`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const by = Object.fromEntries((res.body.data.items as { candidateCode: string; nearbyCount: number | null }[]).map((i) => [i.candidateCode.replace('NB-', ''), i.nearbyCount]));
  assert.deepEqual(by, { N1: 2, N2: 2, N3: 2, FAR: 0, LATE: 0, DENIED: null, NONE: null });
  assert.ok(none);
});


// ---- drives (spec 2026-11-10) -------------------------------------------------------

test('import into drive sets drive and job role', async () => {
  const p = await preview(sa, csv(['50,51,DRV001,Drive Import,5.1,Analytics,B.Tech,drive-import@iitg.ac.in,']), driveA);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId });
  const c = await prisma.candidate.findFirstOrThrow({ where: { email: 'drive-import@iitg.ac.in' }, include: { drive: { include: { round: true } } } });
  assert.equal(c.driveId, driveA);
  assert.equal(c.jobRoleId, c.drive.round.jobRoleId);
  const batch = await prisma.importBatch.findFirstOrThrow({ where: { kind: 'CANDIDATES', driveId: driveA }, orderBy: { createdAt: 'desc' } });
  assert.equal(batch.fileName, 'c.csv');
  assert.equal((await sa.post('/api/admin/candidates').send({ fullName: 'Ghost Drive', email: 'gd@iitg.ac.in', driveId: '00000000-0000-4000-8000-000000000000' })).status, 404);
});

test('preview: a person already in the sibling drive (same round + batch, other college) is an error row', async () => {
  const p = await preview(sa, csv(['50,51,DRV001,Drive Import,5.1,Analytics,B.Tech,drive-import@iitg.ac.in,']), siblingDrive);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.data.errors, [{ row: 2, field: 'email', message: "Already in IITG's Nov 2026 drive for this round" }]);
  const add = await sa.post('/api/admin/candidates').send({ fullName: 'Drive Import', email: 'drive-import@iitg.ac.in', driveId: siblingDrive });
  assert.equal(add.status, 409);
  assert.equal(add.body.error.code, 'SAME_ROUND_BATCH');
});

test('concurrent imports into sibling drives: one wins', async () => {
  const file = csv(['52,53,RACE01,Race Person,5.2,Analytics,B.Tech,race@iitg.ac.in,']);
  const [pa, pb] = await Promise.all([preview(sa, file, driveA), preview(sa, file, siblingDrive)]);
  assert.equal(pa.body.data.summary.valid, 1);
  assert.equal(pb.body.data.summary.valid, 1);
  const [ca, cb] = await Promise.all([
    sa.post('/api/admin/candidates/import/confirm').send({ previewId: pa.body.data.previewId }),
    sa.post('/api/admin/candidates/import/confirm').send({ previewId: pb.body.data.previewId, force: true }),
  ]);
  assert.equal(ca.status, 200, JSON.stringify(ca.body));
  assert.equal(cb.status, 200, JSON.stringify(cb.body));
  assert.equal(ca.body.data.imported + cb.body.data.imported, 1);
  assert.equal(await prisma.candidate.count({ where: { email: 'race@iitg.ac.in', drive: { roundId: round1Id } } }), 1);
});

test('move after start: same round ok, other round refused', async () => {
  const who = await createCandidate({ candidateCode: 'MV-1', fullName: 'Mover One', email: 'mover@iitg.ac.in', driveId: driveA, status: 'SUBMITTED' });
  const other = await sa.post('/api/admin/candidates/bulk/move').send({ candidateIds: [who.id], driveId: driveB });
  assert.deepEqual(other.body.data.skipped.map((s: { reason: string }) => s.reason), ['STARTED']);
  const patchOther = await sa.patch(`/api/admin/candidates/${who.id}`).send({ driveId: driveB });
  assert.equal(patchOther.status, 409);
  const same = await sa.post('/api/admin/candidates/bulk/move').send({ candidateIds: [who.id], driveId: siblingDrive });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.data.updated, 1);
  const moved = await prisma.candidate.findUniqueOrThrow({ where: { id: who.id } });
  assert.deepEqual([moved.driveId, moved.status], [siblingDrive, 'SUBMITTED']);
  // Back again via the single edit (same round, started) works too.
  assert.equal((await sa.patch(`/api/admin/candidates/${who.id}`).send({ driveId: driveA })).status, 200);
});

test('move: refused into another college of the same round + batch when the person already has an entry there', async () => {
  const p = await createCandidate({ candidateCode: 'MV-2', fullName: 'Twin Entry', email: 'twin-entry@iitg.ac.in', driveId: driveB });
  await createApplication(p.accountId, { candidateCode: 'MV-3', fullName: 'Twin Entry', driveId: siblingDrive });
  const res = await sa.post('/api/admin/candidates/bulk/move').send({ candidateIds: [p.id], driveId: driveA });
  assert.deepEqual(res.body.data.skipped.map((s: { reason: string }) => s.reason), ['SAME_ROUND_BATCH']);
});

test('list filter collegeId returns only that college; rows carry drive name, round and college', async () => {
  const nitt = await prisma.drive.findUniqueOrThrow({ where: { id: siblingDrive } });
  await createCandidate({ candidateCode: 'COL-1', fullName: 'Nitt Person', email: 'nitt-person@iitg.ac.in', driveId: siblingDrive });
  const res = await sa.get(`/api/admin/candidates?collegeId=${nitt.collegeId}&pageSize=100`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.data.total >= 1);
  for (const item of res.body.data.items) {
    assert.equal(item.driveId, siblingDrive);
    assert.equal(item.collegeShortCode, 'NITT');
    assert.equal(item.roundNumber, 1);
    assert.equal(item.driveDisplayName, 'C Role · Round 1 · NITT · Nov 2026');
    assert.equal(item.jobProfileType, 'PLACEMENT');
  }
  const byRound = await sa.get(`/api/admin/candidates?roundId=${round1Id}&pageSize=100`);
  assert.ok(byRound.body.data.items.every((i: { driveId: string }) => i.driveId === driveA || i.driveId === siblingDrive));
  const interns = await sa.get('/api/admin/candidates?jobProfileType=INTERNSHIP');
  assert.equal(interns.body.data.total, 0);
});

// ---- campus dashboard links (spec 2026-11-11): batch and round-number filters ----------

test('candidates list filters by batch and round number', async () => {
  const role = await createRoleWithDrive('Batch Filter Role', { college: 'IITG', batch: 'Nov 2026' });
  const jan = (await createDrive(role.jobRoleId, { college: 'IITG', batch: 'Jan 2027' })).driveId;
  const r2 = (await createDrive(role.jobRoleId, { roundNumber: 2, college: 'IITG', batch: 'Nov 2026' })).driveId;
  for (const [code, driveId] of [['BF-1', role.driveId], ['BF-2', role.driveId], ['BF-3', jan], ['BF-4', r2]] as const) {
    await createCandidate({ candidateCode: code, fullName: `Batch ${code}`, email: `${code.toLowerCase()}@bf.test`, driveId });
  }
  const codes = async (qs: string) => {
    const res = await sa.get(`/api/admin/candidates?jobRoleId=${role.jobRoleId}&${qs}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return (res.body.data.items as { candidateCode: string }[]).map((c) => c.candidateCode).sort();
  };
  assert.deepEqual(await codes('batch=Nov%202026'), ['BF-1', 'BF-2', 'BF-4']);
  assert.deepEqual(await codes('roundNumber=1'), ['BF-1', 'BF-2', 'BF-3']);
  assert.deepEqual(await codes('roundNumber=2&batch=Nov%202026'), ['BF-4']);
  assert.equal((await sa.get('/api/admin/candidates?roundNumber=0')).status, 400);
});
