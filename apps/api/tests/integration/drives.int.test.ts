// Colleges, rounds and drives end to end against exam_test (spec 2026-11-10):
// Super Admin only writes, case-insensitive uniqueness, round/drive settings,
// and blind marking (an Evaluator never receives drives or colleges).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createApp } from '../../src/app.js';

const SA = { email: 'super@drives.test', password: 'super-pass-123' };
const EV = { email: 'eval@drives.test', password: 'eval-pass-123' };
let app: Express;
let saAgent: request.Agent;
let evAgent: request.Agent;
let superId = '';

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
    'TRUNCATE TABLE admin_audit_logs, candidates, candidate_accounts, drives, colleges, exam_rounds, job_roles, admin_users RESTART IDENTITY CASCADE',
  );
  await getRedis().flushdb();
  const sa = await prisma.adminUser.create({
    data: { email: SA.email, name: 'Drives Super', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash(SA.password, 4) },
  });
  await prisma.adminUser.create({
    data: { email: EV.email, name: 'Drives Eval', role: 'EVALUATOR', passwordHash: await bcrypt.hash(EV.password, 4) },
  });
  superId = sa.id;
  app = createApp();
  saAgent = await signIn(SA);
  evAgent = await signIn(EV);
});

after(async () => {
  await prisma.$disconnect();
  await getRedis().quit();
});

async function newRole(name: string, type: 'PLACEMENT' | 'INTERNSHIP' = 'PLACEMENT') {
  const res = await saAgent.post('/api/admin/roles').send({ name, type });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data as { id: string; rounds: { id: string; roundNumber: number }[] };
}
async function newCollege(name: string, shortCode: string) {
  const res = await saAgent.post('/api/admin/colleges').send({ name, shortCode });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data as { id: string; shortCode: string };
}

test('create job profile creates Round 1', async () => {
  const role = await newRole('Quant Analyst');
  assert.deepEqual(role.rounds.map((r) => r.roundNumber), [1]);
  const added = await saAgent.post(`/api/admin/roles/${role.id}/rounds`).send({ name: 'Interview test' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.data.roundNumber, 2);
  assert.equal(added.body.data.name, 'Interview test');
  assert.equal(
    (await prisma.adminAuditLog.count({ where: { adminId: superId, action: 'ROUND_CREATED', entityId: added.body.data.id } })),
    1,
  );
});

test('same name allowed once per type', async () => {
  await newRole('Data Engineer', 'PLACEMENT');
  const intern = await saAgent.post('/api/admin/roles').send({ name: 'Data Engineer', type: 'INTERNSHIP' });
  assert.equal(intern.status, 201, JSON.stringify(intern.body));
  assert.equal(intern.body.data.type, 'INTERNSHIP');
  assert.equal((await saAgent.post('/api/admin/roles').send({ name: 'data engineer', type: 'PLACEMENT' })).status, 409);
});

test('colleges: short code upper-cased; duplicate name or code is 409; evaluator POST is 403', async () => {
  assert.equal((await evAgent.post('/api/admin/colleges').send({ name: 'Nope', shortCode: 'NOPE' })).status, 403);
  assert.equal((await evAgent.get('/api/admin/colleges')).status, 403);
  const c = await newCollege('NIT Trichy', 'nitt');
  assert.equal(c.shortCode, 'NITT');
  assert.equal((await saAgent.post('/api/admin/colleges').send({ name: 'nit trichy', shortCode: 'NITT2' })).status, 409);
  assert.equal((await saAgent.post('/api/admin/colleges').send({ name: 'Other', shortCode: 'NITT' })).status, 409);
  const off = await saAgent.patch(`/api/admin/colleges/${c.id}`).send({ active: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.active, false);
  await saAgent.patch(`/api/admin/colleges/${c.id}`).send({ active: true });
});

test('duplicate drive (same round, college, batch differing only by case) → 409', async () => {
  const role = await newRole('Backend Engineer');
  const college = await newCollege('IIT Guwahati', 'IITG');
  const url = `/api/admin/rounds/${role.rounds[0]!.id}/drives`;
  const first = await saAgent.post(url).send({ collegeId: college.id, batch: 'Nov 2026' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.displayName, 'Backend Engineer · Round 1 · IITG · Nov 2026');
  assert.deepEqual(first.body.data.counts, { candidates: 0, started: 0 });
  assert.equal((await saAgent.post(url).send({ collegeId: college.id, batch: 'NOV 2026' })).status, 409);
});

test('same college new batch → 201; drive settings update, window rules, audit', async () => {
  const role = await newRole('Risk Analyst');
  const college = await newCollege('BITS Pilani', 'BITS');
  const url = `/api/admin/rounds/${role.rounds[0]!.id}/drives`;
  assert.equal((await saAgent.post(url).send({ collegeId: college.id, batch: 'Nov 2026' })).status, 201);
  const second = await saAgent.post(url).send({ collegeId: college.id, batch: 'Nov 2026 – Session 2' });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const id = second.body.data.id as string;
  const body = { windowStart: '2026-11-12T04:00:00.000Z', windowEnd: '2026-11-12T10:00:00.000Z', isOpen: true, instructions: 'Read carefully.' };
  const upd = await saAgent.patch(`/api/admin/drives/${id}`).send(body);
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.deepEqual(
    { s: upd.body.data.windowStart, e: upd.body.data.windowEnd, o: upd.body.data.isOpen, i: upd.body.data.instructions },
    { s: body.windowStart, e: body.windowEnd, o: true, i: 'Read carefully.' },
  );
  assert.equal((await saAgent.patch(`/api/admin/drives/${id}`).send({ windowEnd: body.windowStart, windowStart: body.windowStart })).status, 400);
  const audits = await prisma.adminAuditLog.findMany({ where: { action: 'DRIVE_UPDATED', entityId: id } });
  assert.equal(audits.length, 1);
  assert.ok(!JSON.stringify(audits[0]!.metadata).includes('Read carefully'));
  assert.equal((await saAgent.patch('/api/admin/drives/00000000-0000-4000-8000-000000000000').send({ isOpen: true })).status, 404);

  const listed = await saAgent.get(`/api/admin/drives?roundId=${role.rounds[0]!.id}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.length, 2);
});

test('inactive college cannot get a new drive', async () => {
  const role = await newRole('Ops Analyst');
  const college = await newCollege('Closed College', 'CLSD');
  await saAgent.patch(`/api/admin/colleges/${college.id}`).send({ active: false });
  const res = await saAgent.post(`/api/admin/rounds/${role.rounds[0]!.id}/drives`).send({ collegeId: college.id, batch: 'Nov 2026' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'COLLEGE_INACTIVE');
});

test('round settings: duration and weights; evaluator 403; bad weights 400', async () => {
  const role = await newRole('ML Engineer');
  const url = `/api/admin/rounds/${role.rounds[0]!.id}`;
  assert.equal((await evAgent.put(url).send({ durationMinutes: 90 })).status, 403);
  assert.equal((await saAgent.put(url).send({ durationMinutes: 90, weights: { exam: 70, x: 10, xii: 10, cpi: 5 } })).status, 400);
  const res = await saAgent.put(url).send({ durationMinutes: 90, name: 'Aptitude', weights: { exam: 60, x: 20, xii: 10, cpi: 10 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual({ d: res.body.data.durationMinutes, n: res.body.data.name, w: res.body.data.weights }, { d: 90, n: 'Aptitude', w: { exam: 60, x: 20, xii: 10, cpi: 10 } });
});

test("evaluator GET /admin/roles has no drives key and no 'college' anywhere in the body", async () => {
  const res = await evAgent.get('/api/admin/roles');
  assert.equal(res.status, 200);
  assert.ok(res.body.data.length > 0);
  for (const role of res.body.data) for (const r of role.rounds) assert.equal('drives' in r, false);
  assert.ok(!/college/i.test(JSON.stringify(res.body)));
  assert.ok(!JSON.stringify(res.body).includes('IITG'));
  assert.equal((await evAgent.get('/api/admin/drives')).status, 403);
  const sa = await saAgent.get('/api/admin/roles');
  assert.ok(sa.body.data.some((role: { rounds: { drives?: unknown[] }[] }) => role.rounds.some((r) => (r.drives ?? []).length > 0)));
});

// ---- "Move shortlisted to Round 2" (spec 2026-11-10 §5.3) -------------------------

async function entry(code: string, email: string, driveId: string, over: { result?: 'SHORTLISTED' | 'REJECTED'; accountId?: string } = {}) {
  const drive = await prisma.drive.findUniqueOrThrow({ where: { id: driveId }, include: { round: true } });
  const accountId = over.accountId ?? (await prisma.candidateAccount.create({ data: { email } })).id;
  return prisma.candidate.create({
    data: {
      accountId, candidateCode: code, fullName: `Person ${code}`, email, rollNumber: `R-${code}`, majorCpi: 8.1, extra: { hostel: 'H1' },
      jobRoleId: drive.round.jobRoleId, driveId, status: 'EVALUATED', result: over.result ?? null, locationExempt: true,
    },
  });
}

test('promote is idempotent and counts existing entries', async () => {
  const role = await newRole('Promote Role');
  const college = await newCollege('Promote College', 'PRMC');
  const r1 = role.rounds[0]!.id;
  const d1 = (await saAgent.post(`/api/admin/rounds/${r1}/drives`).send({ collegeId: college.id, batch: 'Nov 2026' })).body.data.id as string;
  const r2 = (await saAgent.post(`/api/admin/roles/${role.id}/rounds`).send({})).body.data.id as string;
  const d2 = (await saAgent.post(`/api/admin/rounds/${r2}/drives`).send({ collegeId: college.id, batch: 'nov 2026' })).body.data.id as string;

  const a = await entry('PR-A', 'pr-a@x.test', d1, { result: 'SHORTLISTED' });
  await entry('PR-B', 'pr-b@x.test', d1, { result: 'SHORTLISTED' });
  const c = await entry('PR-C', 'pr-c@x.test', d1, { result: 'SHORTLISTED' });
  await entry('PR-D', 'pr-d@x.test', d1, { result: 'REJECTED' });
  await entry('PR-E', 'pr-e@x.test', d1);
  // C was already put into Round 2 by hand.
  await entry('PR-C2', 'pr-c@x.test', d2, { accountId: c.accountId });

  assert.equal((await evAgent.post(`/api/admin/drives/${d1}/promote`)).status, 403);
  const first = await saAgent.post(`/api/admin/drives/${d1}/promote`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual({ ...first.body.data, skipped: first.body.data.skipped.length }, { targetDriveId: d2, moved: 2, alreadyThere: 1, skipped: 0 });
  const second = await saAgent.post(`/api/admin/drives/${d1}/promote`);
  assert.deepEqual({ m: second.body.data.moved, t: second.body.data.alreadyThere }, { m: 0, t: 3 });

  const inR2 = await prisma.candidate.findMany({ where: { driveId: d2 }, orderBy: { email: 'asc' } });
  assert.deepEqual(inR2.map((x) => x.email), ['pr-a@x.test', 'pr-b@x.test', 'pr-c@x.test']);
  const promotedA = inR2[0]!;
  assert.equal(promotedA.promotedFromId, a.id);
  assert.notEqual(promotedA.candidateCode, a.candidateCode);
  assert.deepEqual(
    [promotedA.status, promotedA.result, promotedA.rollNumber, Number(promotedA.majorCpi), promotedA.extra, promotedA.locationExempt, promotedA.accountId],
    ['NOT_STARTED', null, 'R-PR-A', 8.1, { hostel: 'H1' }, true, a.accountId],
  );
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: a.id } })).result, 'SHORTLISTED', 'Round 1 result kept');
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_PROMOTED' } }), 2);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'DRIVE_PROMOTED', entityId: d1 } }), 2);
});

test('promote without round 2 → 409 NEXT_ROUND_MISSING; without the drive → 409 NEXT_DRIVE_MISSING', async () => {
  const role = await newRole('Promote Solo');
  const college = await newCollege('Promote Solo College', 'PRMS');
  const d1 = (await saAgent.post(`/api/admin/rounds/${role.rounds[0]!.id}/drives`).send({ collegeId: college.id, batch: 'Nov 2026' })).body.data.id as string;
  const noRound = await saAgent.post(`/api/admin/drives/${d1}/promote`);
  assert.equal(noRound.status, 409);
  assert.equal(noRound.body.error.code, 'NEXT_ROUND_MISSING');
  const r2 = (await saAgent.post(`/api/admin/roles/${role.id}/rounds`).send({})).body.data.id as string;
  const noDrive = await saAgent.post(`/api/admin/drives/${d1}/promote`);
  assert.equal(noDrive.status, 409);
  assert.equal(noDrive.body.error.code, 'NEXT_DRIVE_MISSING');
  assert.deepEqual(noDrive.body.error.details, { roundId: r2, collegeId: college.id, batch: 'Nov 2026' });
});

test('a drive with candidates cannot change its batch (keeps the round+batch rule and Round 2 pairing); an empty one can', async () => {
  const role = await newRole('Batch Rename Role');
  const college = await newCollege('Batch Rename College', 'BRNC');
  const url = `/api/admin/rounds/${role.rounds[0]!.id}/drives`;
  const full = (await saAgent.post(url).send({ collegeId: college.id, batch: 'Nov 2026' })).body.data.id as string;
  const empty = (await saAgent.post(url).send({ collegeId: college.id, batch: 'Jan 2027' })).body.data.id as string;
  await entry('BR-1', 'br-1@x.test', full);
  const refused = await saAgent.patch(`/api/admin/drives/${full}`).send({ batch: 'Dec 2026' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /already has candidates/);
  assert.equal((await prisma.drive.findUniqueOrThrow({ where: { id: full } })).batch, 'Nov 2026');
  // Same batch text (only window/open changes) is fine.
  assert.equal((await saAgent.patch(`/api/admin/drives/${full}`).send({ batch: 'Nov 2026', isOpen: true })).status, 200);
  const renamed = await saAgent.patch(`/api/admin/drives/${empty}`).send({ batch: 'Feb 2027' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.data.batch, 'Feb 2027');
});

test('negative marking: set in steps of 0.25, not above the smallest MCQ marks, frozen with the question lock', async () => {
  const role = await newRole('Negative Marking Role');
  const roundId = role.rounds[0]!.id;
  await prisma.question.create({ data: { roundId, type: 'MCQ', text: 'Pick the prime number', normalizedTextHash: 'nm-1', maxMarks: 1, options: ['4', '6', '7', '9'], correctOption: 2 } });
  const ok = await saAgent.put(`/api/admin/rounds/${roundId}`).send({ durationMinutes: 60, mcqNegativeMarks: 0.25 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.mcqNegativeMarks, 0.25);
  const tooMuch = await saAgent.put(`/api/admin/rounds/${roundId}`).send({ durationMinutes: 60, mcqNegativeMarks: 1.5 });
  assert.equal(tooMuch.status, 400, JSON.stringify(tooMuch.body));
  await prisma.examRound.update({ where: { id: roundId }, data: { questionsLocked: true } });
  const locked = await saAgent.put(`/api/admin/rounds/${roundId}`).send({ durationMinutes: 60, mcqNegativeMarks: 0.5 });
  assert.equal(locked.status, 423, JSON.stringify(locked.body));
  assert.equal(locked.body.error.code, 'QUESTIONS_LOCKED');
  // Other settings still change while locked; the negative marking stays.
  const dur = await saAgent.put(`/api/admin/rounds/${roundId}`).send({ durationMinutes: 75 });
  assert.equal(dur.status, 200);
  assert.equal(Number((await prisma.examRound.findUniqueOrThrow({ where: { id: roundId } })).mcqNegativeMarks), 0.25);
});

test('negative marking change racing the first start: re-checked under the round lock (review I1)', async () => {
  const role = await newRole('Negative Race Role');
  const roundId = role.rounds[0]!.id;
  await prisma.question.create({ data: { roundId, type: 'MCQ', text: 'Pick the prime number', normalizedTextHash: `nr-1-${roundId}`, maxMarks: 1, options: ['4', '6', '7', '9'], correctOption: 2 } });
  // A start holds the round row and locks it; the admin's save reads "unlocked" before that commits.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const lockTaken = new Promise<void>((r) => (started = r));
  const start = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE exam_rounds SET questions_locked = true WHERE id = ${roundId}::uuid`;
    started();
    await held;
  }, { timeout: 20_000 });
  await lockTaken;
  const save = saAgent.put(`/api/admin/rounds/${roundId}`).send({ durationMinutes: 60, mcqNegativeMarks: 0.5 }).then((r) => r);
  await new Promise((r) => setTimeout(r, 400));
  release();
  await start;
  const res = await save;
  assert.equal(res.status, 423, JSON.stringify(res.body));
  assert.equal(Number((await prisma.examRound.findUniqueOrThrow({ where: { id: roundId } })).mcqNegativeMarks), 0);
});
