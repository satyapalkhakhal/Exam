// Candidates end to end against exam_test: import per exam (new people, people
// added to an existing person, duplicates), the list (one row per round entry,
// flags per entry), detail registrations, add/remove exam, eligibility session
// revocation and the per-entry attempt reset with its next-round guard.

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
let examA = '';
let examB = '';
let examOff = '';
let examEmpty = '';
let roundA1 = '';
let roundA2 = '';
let roundB1 = '';

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
    'TRUNCATE TABLE admin_audit_logs, activity_logs, candidate_login_logs, candidate_status_history, exam_attempts, round_entries, exam_registrations, candidates, import_batches, questions, exam_rounds, exams, exam_settings, job_roles, admin_users RESTART IDENTITY CASCADE',
  );
  await getRedis().flushdb();
  for (const [c, name, role] of [
    [SA, 'C Super', 'SUPER_ADMIN'],
    [EV, 'C Eval', 'EVALUATOR'],
  ] as const) {
    await prisma.adminUser.create({ data: { email: c.email, name, role, passwordHash: await bcrypt.hash(c.password, 4) } });
  }
  roleId = (await prisma.jobRole.create({ data: { name: 'C Role' } })).id;
  role2Id = (await prisma.jobRole.create({ data: { name: 'C Role Two' } })).id;
  const a = await prisma.exam.create({ data: { jobRoleId: roleId, name: 'C Exam A' } });
  examA = a.id;
  roundA1 = (await prisma.examRound.create({ data: { examId: a.id, roundNumber: 1 } })).id;
  roundA2 = (await prisma.examRound.create({ data: { examId: a.id, roundNumber: 2 } })).id;
  const b = await prisma.exam.create({ data: { jobRoleId: role2Id, name: 'C Exam B' } });
  examB = b.id;
  roundB1 = (await prisma.examRound.create({ data: { examId: b.id, roundNumber: 1, name: 'Aptitude' } })).id;
  const off = await prisma.exam.create({ data: { jobRoleId: roleId, name: 'C Exam Off', active: false } });
  examOff = off.id;
  await prisma.examRound.create({ data: { examId: off.id, roundNumber: 1 } });
  examEmpty = (await prisma.exam.create({ data: { jobRoleId: roleId, name: 'C Exam Empty' } })).id;
  app = createApp();
  sa = await signIn(SA);
  ev = await signIn(EV);
});

after(async () => {
  await prisma.$disconnect();
  await getRedis().quit();
});

const HEAD = 'schooling.x_percentage,schooling.xii_percentage,roll_number,name,major_cpi,major.discipline,major.programme,email,hostel';
const csv = (rows: string[], head = HEAD) => Buffer.from([head, ...rows].join('\n'));
const three = csv([
  '97.6,99.8,254101009,AJITH K K,8.67,Computer Science and Engineering,M.Tech,K.Ajith@iitg.ac.in,Brahmaputra',
  '90,91,254101010,Bina Rao,9.1,Electrical,B.Tech,bina@iitg.ac.in,',
  '80,81,254101011,Chandan Das,7.5,Civil,B.Tech,chandan@iitg.ac.in,',
]);

const preview = (agent: request.Agent, file: Buffer, examId: string) =>
  agent.post('/api/admin/candidates/import/preview').field('examId', examId).attach('file', file, 'c.csv');

const idOf = async (email: string) => (await prisma.candidate.findUniqueOrThrow({ where: { email } })).id;
const entryOf = async (email: string, roundId: string) =>
  (await prisma.roundEntry.findFirstOrThrow({ where: { roundId, registration: { candidate: { email } } } })).id;

async function attemptOn(entryId: string, status: 'IN_PROGRESS' | 'SUBMITTED' = 'SUBMITTED') {
  const entry = await prisma.roundEntry.findUniqueOrThrow({ where: { id: entryId }, include: { registration: true } });
  const now = new Date();
  return prisma.examAttempt.create({
    data: {
      candidateId: entry.registration.candidateId,
      roundEntryId: entryId,
      status,
      startedAt: now,
      endsAt: now,
      submittedAt: status === 'SUBMITTED' ? now : null,
      activeSessionId: 's',
      startIp: '1.1.1.1',
      userAgent: 'ua',
      maxMarks: 10,
    },
  });
}

test('template.csv carries the HR header row plus mobile and exam', async () => {
  const res = await sa.get('/api/admin/candidates/template.csv');
  assert.equal(res.status, 200);
  assert.match(res.text, /^schooling\.x_percentage,.*,email,mobile,exam\n$/);
});

test('import 3 rows into an exam: each gets a registration and a Round 1 entry; codes and lower-cased email stored', async () => {
  const p = await preview(sa, three, examA);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.data.summary, { total: 3, valid: 3, errors: 0, duplicates: 0, addedToExisting: 0 });
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
  for (const item of list.body.data.items) {
    assert.equal(item.examId, examA);
    assert.equal(item.examName, 'C Exam A');
    assert.equal(item.roundId, roundA1);
    assert.equal(item.roundNumber, 1);
    assert.equal(item.jobRoleId, roleId);
    assert.equal(item.status, 'NOT_STARTED');
    assert.equal(item.flagCount, 0);
  }
  const ajith = await prisma.candidate.findUniqueOrThrow({ where: { email: 'k.ajith@iitg.ac.in' } });
  assert.deepEqual(ajith.extra, { hostel: 'Brahmaputra' });
  const batch = await prisma.importBatch.findFirstOrThrow({ where: { kind: 'CANDIDATES' } });
  assert.equal(batch.examId, examA);
  assert.equal(await prisma.examRegistration.count({ where: { examId: examA, importBatchId: batch.id } }), 3);
  assert.equal(await prisma.candidateStatusHistory.count({ where: { roundEntry: { roundId: roundA1 }, toStatus: 'NOT_STARTED' } }), 3);
});

test('the same file again is 409 until forced; re-imported rows are EXISTS duplicates', async () => {
  const p = await preview(sa, three, examA);
  assert.equal(p.body.data.summary.duplicates, 3);
  const c = await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId });
  assert.equal(c.status, 409);
  const f = await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId, force: true });
  assert.equal(f.status, 200);
  assert.deepEqual(f.body.data, { imported: 0, skipped: 3 });
});

test('import preview needs an active exam with a round', async () => {
  assert.equal((await preview(sa, three, examOff)).status, 409);
  assert.equal((await preview(sa, three, examEmpty)).status, 409);
  assert.equal((await preview(sa, three, '00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal(
    (await sa.post('/api/admin/candidates/import/preview').field('jobRoleId', roleId).attach('file', three, 'c.csv')).status,
    400,
  );
});

test('import never overwrites profile', async () => {
  const created = await sa.post('/api/admin/candidates').send({ fullName: 'Asha Rao', email: 'asha@cands.test', xPercentage: 70, examId: examA });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const head = `${HEAD},exam`;
  const file = csv(
    [
      '95,96,9,A. Rao,9.9,Civil,B.Tech,ASHA@cands.test,North,',
      '88,89,10,Esha Sen,8,Civil,B.Tech,esha@cands.test,,',
      '88,89,10,E. Sen,8,Civil,B.Tech,esha@cands.test,,C Exam A',
      '88,89,11,Off Person,8,Civil,B.Tech,off@cands.test,,C Exam Off',
    ],
    head,
  );
  const p = await preview(sa, file, examB);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.data.summary, { total: 4, valid: 3, errors: 1, duplicates: 0, addedToExisting: 2 });
  assert.deepEqual(p.body.data.errors.map((e: { row: number; field: string }) => [e.row, e.field]), [[5, 'exam']]);
  const c = await sa.post('/api/admin/candidates/import/confirm').send({ previewId: p.body.data.previewId });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(c.body.data, { imported: 3, skipped: 1 });

  const asha = await prisma.candidate.findUniqueOrThrow({ where: { email: 'asha@cands.test' } });
  assert.equal(asha.fullName, 'Asha Rao');
  assert.equal(Number(asha.xPercentage), 70);
  assert.equal(asha.rollNumber, null);
  assert.deepEqual(asha.extra, {});
  const regs = await prisma.examRegistration.findMany({ where: { candidateId: asha.id }, include: { entries: true } });
  assert.deepEqual(regs.map((r) => r.examId).sort(), [examA, examB].sort());
  assert.ok(regs.every((r) => r.entries.length === 1));

  // one person, two registrations; the first row's profile wins
  const esha = await prisma.candidate.findUniqueOrThrow({ where: { email: 'esha@cands.test' }, include: { registrations: true } });
  assert.equal(esha.fullName, 'Esha Sen');
  assert.deepEqual(esha.registrations.map((r) => r.examId).sort(), [examA, examB].sort());
  assert.equal(await prisma.candidate.count({ where: { email: 'off@cands.test' } }), 0);
});

test('import rows whose mobile belongs to another candidate are errors', async () => {
  await prisma.candidate.update({ where: { email: 'chandan@iitg.ac.in' }, data: { mobile: '9123456780' } });
  const file = csv(['1,1,1,Ghost Mob,1,X,Y,ghostmob@cands.test,,9123456780', '1,1,1,Bina R,1,X,Y,bina@iitg.ac.in,,9123456780'], `${HEAD},mobile`);
  const p = await preview(sa, file, examB);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(
    p.body.data.errors.map((e: { row: number; field: string; message: string }) => [e.row, e.field, e.message]),
    [
      [2, 'mobile', 'mobile belongs to another candidate'],
      [3, 'mobile', 'mobile belongs to another candidate'],
    ],
  );
});

test('list shows one row per entry', async () => {
  const s = await sa.get('/api/admin/candidates?search=asha');
  assert.equal(s.body.data.total, 2);
  const asha = await idOf('asha@cands.test');
  // qualifying for round 2 adds a third row for the same person
  const reg = await prisma.examRegistration.findFirstOrThrow({ where: { candidateId: asha, examId: examA } });
  await prisma.roundEntry.create({ data: { registrationId: reg.id, roundId: roundA2 } });
  const rows = (await sa.get('/api/admin/candidates?search=asha')).body.data.items as { id: string; entryId: string; examName: string; roundNumber: number }[];
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.id === asha));
  assert.equal(new Set(rows.map((r) => r.entryId)).size, 3);
  assert.deepEqual(rows.map((r) => `${r.examName}#${r.roundNumber}`).sort(), ['C Exam A#1', 'C Exam A#2', 'C Exam B#1']);
});

test('list search, sort and filters (job profile, exam, round, status); pageSize above 100 is rejected', async () => {
  const s = await sa.get('/api/admin/candidates?search=bina');
  assert.equal(s.body.data.total, 1);
  const sorted = await sa.get('/api/admin/candidates?sort=majorCpi&dir=desc');
  assert.equal(sorted.body.data.items[0].majorCpi, 9.1);
  // examA: ajith, bina, chandan, asha, esha (round 1) + asha (round 2); examB: asha, esha
  assert.equal((await sa.get(`/api/admin/candidates?jobRoleId=${role2Id}`)).body.data.total, 2);
  assert.equal((await sa.get(`/api/admin/candidates?examId=${examB}`)).body.data.total, 2);
  assert.equal((await sa.get(`/api/admin/candidates?examId=${examA}`)).body.data.total, 6);
  assert.equal((await sa.get(`/api/admin/candidates?roundId=${roundA2}`)).body.data.total, 1);
  assert.equal((await sa.get(`/api/admin/candidates?roundId=${roundB1}`)).body.data.items[0].roundId, roundB1);
  await prisma.roundEntry.update({ where: { id: await entryOf('esha@cands.test', roundB1) }, data: { status: 'SUBMITTED' } });
  const sub = await sa.get(`/api/admin/candidates?status=SUBMITTED`);
  assert.equal(sub.body.data.total, 1);
  assert.equal(sub.body.data.items[0].examId, examB);
  await prisma.roundEntry.update({ where: { id: await entryOf('esha@cands.test', roundB1) }, data: { status: 'NOT_STARTED' } });
  assert.equal((await sa.get('/api/admin/candidates?pageSize=101')).status, 400);
});

test('flagCount is per round entry: integrity from that entry attempt, flagged filter on it', async () => {
  const bina = await idOf('bina@iitg.ac.in');
  const reg = await sa.post(`/api/admin/candidates/${bina}/registrations`).send({ examId: examB });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const attempt = await attemptOn(await entryOf('bina@iitg.ac.in', roundA1));
  const evt = (eventType: string) => ({ candidateId: bina, attemptId: attempt.id, eventType, ip: '1.1.1.1' });
  // one blocked paste + tab switched 3 times (counts once); a window blur alone never counts
  await prisma.activityLog.createMany({ data: [evt('PASTE_ATTEMPT'), evt('TAB_HIDDEN'), evt('TAB_HIDDEN'), evt('TAB_HIDDEN'), evt('WINDOW_BLUR')] });

  const list = await sa.get('/api/admin/candidates?search=bina');
  const byExam = Object.fromEntries(list.body.data.items.map((i: { examId: string; flagCount: number }) => [i.examId, i.flagCount]));
  assert.deepEqual(byExam, { [examA]: 2, [examB]: 0 });
  const flagged = await sa.get('/api/admin/candidates?flagged=true');
  assert.deepEqual(flagged.body.data.items.map((i: { id: string; examId: string }) => [i.id, i.examId]), [[bina, examA]]);
  assert.equal(flagged.body.data.total, 1);
  const total = (await sa.get('/api/admin/candidates')).body.data.total;
  const clean = await sa.get('/api/admin/candidates?flagged=false&pageSize=100');
  assert.equal(clean.body.data.total, total - 1);
  assert.ok(clean.body.data.items.every((i: { flagCount: number }) => i.flagCount === 0));

  // detail: person-level flags; registrations list both exams
  const d = await sa.get(`/api/admin/candidates/${bina}`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.deepEqual(d.body.data.flags, {
    integrity: { pasteAttempts: 1, bulkInsert: 0, tabHidden: 3, blur: 1, ipChanges: 0 },
    location: [],
  });
  assert.equal(d.body.data.attempt.id, attempt.id);
});

test('an Evaluator calling list, detail, registrations or import gets 403', async () => {
  const bina = await idOf('bina@iitg.ac.in');
  assert.equal((await ev.get('/api/admin/candidates')).status, 403);
  assert.equal((await ev.get(`/api/admin/candidates/${bina}`)).status, 403);
  assert.equal((await ev.post(`/api/admin/candidates/${bina}/registrations`).send({ examId: examB })).status, 403);
  assert.equal((await preview(ev, three, examA)).status, 403);
});

test('detail returns profile, extra, registrations with rounds and zero flags', async () => {
  const asha = await idOf('asha@cands.test');
  const d = await sa.get(`/api/admin/candidates/${asha}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.data.attempt, null);
  assert.deepEqual(d.body.data.flags, { integrity: { pasteAttempts: 0, bulkInsert: 0, tabHidden: 0, blur: 0, ipChanges: 0 }, location: [] });
  assert.equal(d.body.data.activity.total, 0);
  const regs = d.body.data.registrations as {
    registrationId: string; examId: string; examName: string; jobRoleName: string;
    entries: { entryId: string; roundId: string; roundNumber: number; roundName: string; status: string; attempt: unknown }[];
  }[];
  assert.deepEqual(
    regs.map((r) => [r.examName, r.jobRoleName, r.entries.map((e) => [e.roundNumber, e.roundName, e.status, e.attempt])]),
    [
      ['C Exam A', 'C Role', [[1, '', 'NOT_STARTED', null], [2, '', 'NOT_STARTED', null]]],
      ['C Exam B', 'C Role Two', [[1, 'Aptitude', 'NOT_STARTED', null]]],
    ],
  );
  const ajith = await prisma.candidate.findUniqueOrThrow({ where: { email: 'k.ajith@iitg.ac.in' } });
  const da = await sa.get(`/api/admin/candidates/${ajith.id}`);
  assert.equal(da.body.data.candidate.extra.hostel, 'Brahmaputra');
  assert.equal(da.body.data.candidate.examId, examA);
  assert.equal((await sa.get('/api/admin/candidates/00000000-0000-4000-8000-000000000000')).status, 404);
});

test('edit lower-cases email; a duplicate email is 409; the job profile is no longer editable', async () => {
  const bina = await idOf('bina@iitg.ac.in');
  const e = await sa.patch(`/api/admin/candidates/${bina}`).send({ email: 'Bina.R@iitg.ac.in', mobile: '+91 98765 43210' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.data.email, 'bina.r@iitg.ac.in');
  assert.equal(e.body.data.mobile, '9876543210');
  assert.equal((await sa.patch(`/api/admin/candidates/${bina}`).send({ email: 'chandan@iitg.ac.in' })).status, 409);
  assert.equal((await sa.patch(`/api/admin/candidates/${bina}`).send({ jobRoleId: role2Id })).status, 400);
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
  await prisma.candidate.update({ where: { id: c.id }, data: { eligible: true } });
});

test('reset-attempt on an entry needs a 10+ char reason, marks the attempt RESET, and a new attempt can then be created', async () => {
  const id = await idOf('k.ajith@iitg.ac.in');
  const entryId = await entryOf('k.ajith@iitg.ac.in', roundA1);
  const url = `/api/admin/candidates/${id}/entries/${entryId}/reset-attempt`;
  await attemptOn(entryId);
  await prisma.roundEntry.update({ where: { id: entryId }, data: { status: 'SUBMITTED' } });

  assert.equal((await sa.post(`/api/admin/candidates/${id}/reset-attempt`).send({ reason: 'Power cut during the exam' })).status, 404);
  assert.equal((await sa.post(url).send({ reason: 'short' })).status, 400);
  const otherEntry = await entryOf('bina.r@iitg.ac.in', roundA1);
  assert.equal((await sa.post(`/api/admin/candidates/${id}/entries/${otherEntry}/reset-attempt`).send({ reason: 'Not this candidate entry' })).status, 404);

  const r = await sa.post(url).send({ reason: 'Power cut during the exam' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await prisma.roundEntry.findUniqueOrThrow({ where: { id: entryId } })).status, 'NOT_STARTED');
  assert.equal((await prisma.examAttempt.findMany({ where: { roundEntryId: entryId } }))[0]?.status, 'RESET');
  const hist = await prisma.candidateStatusHistory.findMany({ where: { roundEntryId: entryId, comment: { not: null } } });
  assert.equal(hist.length, 1);
  assert.deepEqual([hist[0]?.fromStatus, hist[0]?.toStatus, hist[0]?.comment], ['SUBMITTED', 'NOT_STARTED', 'Power cut during the exam']);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_ATTEMPT_RESET', entityId: id } }), 1);

  await attemptOn(entryId);
  assert.equal(await prisma.examAttempt.count({ where: { roundEntryId: entryId } }), 2);
  assert.equal((await sa.post(url).send({ reason: 'Second reset please' })).status, 200);
  assert.equal((await sa.post(url).send({ reason: 'Nothing left to reset' })).status, 409);
});

test('reset refused when next round started; an untouched next-round entry is removed', async () => {
  const id = await idOf('chandan@iitg.ac.in');
  const e1 = await entryOf('chandan@iitg.ac.in', roundA1);
  const a1 = await attemptOn(e1);
  await prisma.roundEntry.update({ where: { id: e1 }, data: { status: 'SHORTLISTED' } });
  const reg = await prisma.examRegistration.findFirstOrThrow({ where: { candidateId: id, examId: examA } });
  const e2 = (await prisma.roundEntry.create({ data: { registrationId: reg.id, roundId: roundA2 } })).id;
  const a2 = await attemptOn(e2, 'IN_PROGRESS');
  await prisma.roundEntry.update({ where: { id: e2 }, data: { status: 'IN_PROGRESS' } });

  const url = `/api/admin/candidates/${id}/entries/${e1}/reset-attempt`;
  const refused = await sa.post(url).send({ reason: 'Wants to sit round one again' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.message, 'The candidate has already started the next round.');
  assert.equal((await prisma.examAttempt.findUniqueOrThrow({ where: { id: a1.id } })).status, 'SUBMITTED');
  assert.equal((await prisma.roundEntry.findUniqueOrThrow({ where: { id: e1 } })).status, 'SHORTLISTED');
  assert.equal((await prisma.examAttempt.findUniqueOrThrow({ where: { id: a2.id } })).status, 'IN_PROGRESS');
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_ATTEMPT_RESET', entityId: id } }), 0);

  // Asha: round 1 shortlisted, round 2 entry never started -> reset removes it
  const asha = await idOf('asha@cands.test');
  const ashaE1 = await entryOf('asha@cands.test', roundA1);
  await attemptOn(ashaE1);
  await prisma.roundEntry.update({ where: { id: ashaE1 }, data: { status: 'SHORTLISTED' } });
  const ok = await sa.post(`/api/admin/candidates/${asha}/entries/${ashaE1}/reset-attempt`).send({ reason: 'Re-sit after the outage' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await prisma.roundEntry.count({ where: { roundId: roundA2, registration: { candidateId: asha } } }), 0);
});

test('create with existing email → 409 with candidateId; create registers for the exam Round 1', async () => {
  const res = await sa.post('/api/admin/candidates').send({
    fullName: 'Dipak Rout',
    email: 'Dipak.Rout@Cands.test',
    mobile: '+91 90045 41335',
    rollNumber: '11111',
    xPercentage: 80,
    xiiPercentage: 80,
    examId: examB,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const c = res.body.data;
  assert.match(c.candidateCode, /^ARH-EX-\d{6}$/);
  assert.equal(c.email, 'dipak.rout@cands.test');
  assert.equal(c.mobile, '9004541335');
  assert.equal(c.status, 'NOT_STARTED');
  assert.equal(c.majorCpi, null);
  assert.deepEqual([c.examId, c.roundId, c.roundNumber, c.jobRoleId, c.jobRoleName], [examB, roundB1, 1, role2Id, 'C Role Two']);
  const audit = await prisma.adminAuditLog.findFirst({ where: { entityId: c.id, action: 'CANDIDATE_CREATED' } });
  assert.ok(audit);
  const stored = await prisma.candidate.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(stored.jobRoleId, null);

  const dupEmail = await sa.post('/api/admin/candidates').send({ fullName: 'Other', email: 'dipak.rout@cands.test', examId: examA });
  assert.equal(dupEmail.status, 409);
  assert.equal(dupEmail.body.error.code, 'CONFLICT');
  assert.equal(dupEmail.body.error.message, 'This email already belongs to a candidate. Add the exam from their page.');
  assert.deepEqual(dupEmail.body.error.details, { candidateId: c.id });
  const dupMobile = await sa.post('/api/admin/candidates').send({ fullName: 'Other', email: 'other@cands.test', mobile: '9004541335', examId: examA });
  assert.equal(dupMobile.status, 409);
  assert.equal(await prisma.candidate.count({ where: { email: 'other@cands.test' } }), 0);

  const minimal = await sa.post('/api/admin/candidates').send({ fullName: 'Only Required', email: 'min@cands.test', examId: examA });
  assert.equal(minimal.status, 201, 'name, email and exam are the only required fields');

  for (const bad of [
    { fullName: 'X', email: 'x@cands.test', examId: examA },
    { fullName: 'Bad Mail', email: 'dipak', examId: examA },
    { fullName: 'Bad Pct', email: 'p@cands.test', xPercentage: 101, examId: examA },
    { fullName: 'Bad Cpi', email: 'q@cands.test', majorCpi: 11, examId: examA },
    { fullName: 'No Exam', email: 'r@cands.test' },
    { fullName: 'Old Shape', email: 'r@cands.test', jobRoleId: roleId },
  ]) {
    assert.equal((await sa.post('/api/admin/candidates').send(bad)).status, 400, JSON.stringify(bad));
  }
  const ghost = await sa.post('/api/admin/candidates').send({ fullName: 'Ghost Exam', email: 'g@cands.test', examId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(ghost.status, 404);
  const off = await sa.post('/api/admin/candidates').send({ fullName: 'Off Exam', email: 'g@cands.test', examId: examOff });
  assert.equal(off.status, 409);
  assert.equal(off.body.error.message, 'This exam is not active.');
  assert.equal((await sa.post('/api/admin/candidates').send({ fullName: 'Empty Exam', email: 'g@cands.test', examId: examEmpty })).status, 409);
  assert.equal(await prisma.candidate.count({ where: { email: 'g@cands.test' } }), 0);

  assert.equal((await ev.post('/api/admin/candidates').send({ fullName: 'Eval Try', email: 'e@cands.test', examId: examA })).status, 403);
});

test('add exam registers for Round 1; already registered or inactive exam is 409; audited', async () => {
  const id = await idOf('min@cands.test');
  const add = await sa.post(`/api/admin/candidates/${id}/registrations`).send({ examId: examB });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.body.data.examId, examB);
  assert.deepEqual(add.body.data.entries.map((e: { roundId: string; status: string }) => [e.roundId, e.status]), [[roundB1, 'NOT_STARTED']]);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_REGISTERED', entityId: id } }), 1);

  const again = await sa.post(`/api/admin/candidates/${id}/registrations`).send({ examId: examB });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.message, 'Already registered for this exam.');
  const off = await sa.post(`/api/admin/candidates/${id}/registrations`).send({ examId: examOff });
  assert.equal(off.status, 409);
  assert.equal(off.body.error.message, 'This exam is not active.');
  assert.equal((await sa.post(`/api/admin/candidates/${id}/registrations`).send({ examId: 'nope' })).status, 400);
  assert.equal((await sa.post('/api/admin/candidates/00000000-0000-4000-8000-000000000000/registrations').send({ examId: examB })).status, 404);
});

test('remove last registration → 409', async () => {
  const id = await idOf('dipak.rout@cands.test');
  const reg = await prisma.examRegistration.findFirstOrThrow({ where: { candidateId: id } });
  const res = await sa.delete(`/api/admin/candidates/${id}/registrations/${reg.id}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.message, 'A candidate must keep at least one exam. Disable the candidate instead.');
  assert.equal(await prisma.examRegistration.count({ where: { candidateId: id } }), 1);
});

test('remove registration after start → 409; an unstarted one is removed with its entries, audited', async () => {
  const bina = await idOf('bina.r@iitg.ac.in');
  const started = await prisma.examRegistration.findFirstOrThrow({ where: { candidateId: bina, examId: examA } });
  const res = await sa.delete(`/api/admin/candidates/${bina}/registrations/${started.id}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.message, 'This exam has already been started and cannot be removed.');

  const min = await idOf('min@cands.test');
  const regB = await prisma.examRegistration.findFirstOrThrow({ where: { candidateId: min, examId: examB } });
  assert.equal((await sa.delete(`/api/admin/candidates/${bina}/registrations/${regB.id}`)).status, 404);
  const ok = await sa.delete(`/api/admin/candidates/${min}/registrations/${regB.id}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await prisma.examRegistration.count({ where: { id: regB.id } }), 0);
  assert.equal(await prisma.roundEntry.count({ where: { registrationId: regB.id } }), 0);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_REGISTRATION_REMOVED', entityId: min } }), 1);
});

test('preview reports source line numbers when a blank row sits inside the file', async () => {
  const file = Buffer.from([HEAD, ',,,,,,,,', '90,91,1,Dev Rao,11,Civil,B.Tech,dev@iitg.ac.in,'].join('\n'));
  const p = await preview(sa, file, examA);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.data.errors.map((e: { row: number; field: string }) => [e.row, e.field]), [[3, 'major_cpi']]);
});
