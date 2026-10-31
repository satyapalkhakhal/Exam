// Exams and rounds admin API against exam_test: RBAC (any admin lists, only
// Super Admin writes), name uniqueness, round numbering, settings, backfill of
// shortlisted people into a late round, and auditing.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createApp } from '../../src/app.js';

const SA = { email: 'super@exams.test', password: 'super-pass-123' };
const EV = { email: 'eval@exams.test', password: 'eval-pass-123' };
let app: Express;
let saAgent: request.Agent;
let evAgent: request.Agent;

async function signIn(creds: { email: string; password: string }) {
  const stale = [...(await getRedis().keys('exam:otp:cd:admin_login:*')), ...(await getRedis().keys('exam:rl:*'))];
  if (stale.length > 0) await getRedis().del(...stale);
  const agent = request.agent(app);
  const login = await agent.post('/api/admin/auth/login').send(creds);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const verify = await agent
    .post('/api/admin/auth/verify-otp')
    .send({ challengeId: login.body.data.challengeId, code: '123456' });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  return agent;
}

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  assert.match(env.REDIS_URL, /\/15$/);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE admin_audit_logs, round_entries, exam_registrations, candidates, exam_rounds, exams, job_roles, admin_users RESTART IDENTITY CASCADE',
  );
  await getRedis().flushdb();
  const sa = await prisma.adminUser.create({
    data: { email: SA.email, name: 'Exams Super', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash(SA.password, 4) },
  });
  await prisma.adminUser.create({
    data: { email: EV.email, name: 'Exams Eval', role: 'EVALUATOR', passwordHash: await bcrypt.hash(EV.password, 4) },
  });
  app = createApp();
  saAgent = await signIn(SA);
  evAgent = await signIn(EV);
});

after(async () => {
  await prisma.$disconnect();
  await getRedis().quit();
});

const settingsBody = {
  durationMinutes: 90,
  windowStart: '2026-11-10T04:00:00.000Z',
  windowEnd: '2026-11-10T10:00:00.000Z',
  instructions: 'Read carefully.',
  isOpen: true,
};

let roleA = '';
let roleB = '';
let examId = '';
let round1Id = '';

test('setup profiles', async () => {
  roleA = (await prisma.jobRole.create({ data: { name: 'Backend' } })).id;
  roleB = (await prisma.jobRole.create({ data: { name: 'Frontend' } })).id;
});

test('evaluator cannot create (403); unauthenticated 401; evaluator can list', async () => {
  assert.equal((await evAgent.post('/api/admin/exams').send({ jobRoleId: roleA, name: 'Nope' })).status, 403);
  assert.equal((await request(app).get('/api/admin/exams')).status, 401);
  assert.equal((await evAgent.get('/api/admin/exams')).status, 200);
  assert.equal((await evAgent.post('/api/admin/exams/x/rounds').send({})).status, 403);
});

test('create exam + round 1 + settings', async () => {
  const created = await saAgent.post('/api/admin/exams').send({ jobRoleId: roleA, name: 'Backend Nov 2026' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.jobRoleName, 'Backend');
  assert.equal(created.body.data.active, true);
  assert.deepEqual(created.body.data.rounds, []);
  examId = created.body.data.id;

  const r1 = await saAgent.post(`/api/admin/exams/${examId}/rounds`).send({ name: 'Aptitude' });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.data.roundNumber, 1);
  assert.equal(r1.body.data.name, 'Aptitude');
  assert.equal(r1.body.data.durationMinutes, 60);
  assert.equal(r1.body.data.isOpen, false);
  assert.deepEqual(r1.body.data.counts, { questions: 0, entries: 0 });
  round1Id = r1.body.data.id;

  const url = `/api/admin/exams/rounds/${round1Id}/settings`;
  assert.equal((await evAgent.put(url).send(settingsBody)).status, 403);
  assert.equal((await saAgent.put(url).send({ ...settingsBody, durationMinutes: 5 })).status, 400);
  assert.equal((await saAgent.put(url).send({ ...settingsBody, windowEnd: settingsBody.windowStart })).status, 400);
  const res = await saAgent.put(url).send(settingsBody);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.durationMinutes, 90);
  assert.equal(res.body.data.windowStart, '2026-11-10T04:00:00.000Z');
  assert.equal(res.body.data.isOpen, true);
  assert.equal(
    (await saAgent.put('/api/admin/exams/rounds/00000000-0000-4000-8000-000000000000/settings').send(settingsBody)).status,
    404,
  );

  const listed = (await evAgent.get(`/api/admin/exams?jobRoleId=${roleA}`)).body.data;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].rounds[0].durationMinutes, 90);

  const audited = await prisma.adminAuditLog.findMany({ where: { action: 'ROUND_SETTINGS_UPDATED', entityId: round1Id } });
  assert.equal(audited.length, 1);
  assert.ok(!JSON.stringify(audited[0]?.metadata).includes('Read carefully'));
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'ROUND_CREATED', entityId: round1Id } }), 1);
});

test('exam name unique across profiles -> 409; unknown profile 404', async () => {
  const dup = await saAgent.post('/api/admin/exams').send({ jobRoleId: roleB, name: 'Backend Nov 2026' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.message, 'An exam with this name already exists.');
  assert.equal(
    (await saAgent.post('/api/admin/exams').send({ jobRoleId: '00000000-0000-4000-8000-000000000000', name: 'X' })).status,
    404,
  );
  assert.equal((await saAgent.post('/api/admin/exams').send({ jobRoleId: roleB, name: ' ' })).status, 400);
  const other = await saAgent.post('/api/admin/exams').send({ jobRoleId: roleB, name: 'Frontend Nov 2026' });
  assert.equal(other.status, 201);
  assert.equal((await saAgent.patch(`/api/admin/exams/${other.body.data.id}`).send({ name: 'Backend Nov 2026' })).status, 409);
});

test('add round 2 backfills shortlisted of round 1', async () => {
  const mk = async (n: number, status: 'SHORTLISTED' | 'REJECTED' | 'NOT_STARTED') => {
    const c = await prisma.candidate.create({
      data: { candidateCode: `EX-${n}`, fullName: `P${n}`, email: `p${n}@exams.test`, mobile: `900000000${n}` },
    });
    const reg = await prisma.examRegistration.create({ data: { candidateId: c.id, examId } });
    const entry = await prisma.roundEntry.create({ data: { registrationId: reg.id, roundId: round1Id, status } });
    return { c, entry };
  };
  const a = await mk(1, 'SHORTLISTED');
  await mk(2, 'REJECTED');
  await mk(3, 'NOT_STARTED');

  const r2 = await saAgent.post(`/api/admin/exams/${examId}/rounds`).send({});
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(r2.body.data.roundNumber, 2);
  assert.equal(r2.body.data.name, '');
  assert.deepEqual(r2.body.data.counts, { questions: 0, entries: 1 });

  const entries = await prisma.roundEntry.findMany({ where: { roundId: r2.body.data.id }, include: { registration: true } });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.registration.candidateId, a.c.id);
  assert.equal(entries[0]?.status, 'NOT_STARTED');
  const hist = await prisma.candidateStatusHistory.findMany({ where: { roundEntryId: entries[0]?.id } });
  assert.equal(hist.length, 1);
  assert.equal(hist[0]?.fromStatus, null);
  assert.equal(hist[0]?.toStatus, 'NOT_STARTED');
  assert.equal(hist[0]?.candidateId, a.c.id);
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'ROUND_CREATED', entityId: r2.body.data.id } });
  assert.equal((audit.metadata as { backfilled: number }).backfilled, 1);

  const r3 = await saAgent.post(`/api/admin/exams/${examId}/rounds`).send({});
  assert.equal(r3.body.data.roundNumber, 3);
  assert.equal(r3.body.data.counts.entries, 0);
  assert.equal((await saAgent.post('/api/admin/exams/00000000-0000-4000-8000-000000000000/rounds').send({})).status, 404);
});

test('deactivate exam hides it from GET ?active=true', async () => {
  const res = await saAgent.patch(`/api/admin/exams/${examId}`).send({ active: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.active, false);
  const active = (await evAgent.get('/api/admin/exams?active=true')).body.data;
  assert.ok(!active.some((e: { id: string }) => e.id === examId));
  const inactive = (await evAgent.get('/api/admin/exams?active=false')).body.data;
  assert.ok(inactive.some((e: { id: string }) => e.id === examId));
  assert.equal((await evAgent.get('/api/admin/exams?active=maybe')).status, 400);
  assert.equal((await saAgent.patch(`/api/admin/exams/${examId}`).send({})).status, 400);
  assert.equal((await saAgent.patch('/api/admin/exams/00000000-0000-4000-8000-000000000000').send({ active: true })).status, 404);
});

// ---- qualification SQL against the real database ----
import { backfillNewRound, grantNextRound, revokeNextRound } from '../../src/modules/rounds/qualification.js';

async function twoRoundExam(tag: string) {
  const exam = await prisma.exam.create({ data: { jobRoleId: roleA, name: `Qual ${tag}` } });
  const r1 = await prisma.examRound.create({ data: { examId: exam.id, roundNumber: 1 } });
  const r2 = await prisma.examRound.create({ data: { examId: exam.id, roundNumber: 2 } });
  const cand = await prisma.candidate.create({
    data: { candidateCode: `Q-${tag}`, fullName: `Q ${tag}`, email: `q-${tag}@exams.test`, mobile: null },
  });
  const reg = await prisma.examRegistration.create({ data: { candidateId: cand.id, examId: exam.id } });
  const e1 = await prisma.roundEntry.create({ data: { registrationId: reg.id, roundId: r1.id, status: 'SHORTLISTED' } });
  return { exam, r1, r2, cand, reg, e1 };
}

test('qualification: grant creates and revoke removes the next entry with its history', async () => {
  const x = await twoRoundExam('a');
  const adminId = (await prisma.adminUser.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } })).id;
  const id = await prisma.$transaction((tx) => grantNextRound(tx, x.e1.id, adminId));
  assert.ok(id);
  assert.equal(await prisma.$transaction((tx) => grantNextRound(tx, x.e1.id, adminId)), id);
  const entry = await prisma.roundEntry.findUniqueOrThrow({ where: { id: id! } });
  assert.equal(entry.roundId, x.r2.id);
  assert.equal(entry.status, 'NOT_STARTED');
  const hist = await prisma.candidateStatusHistory.findMany({ where: { roundEntryId: id! } });
  assert.equal(hist.length, 1);
  assert.equal(hist[0]?.fromStatus, null);
  assert.equal(hist[0]?.toStatus, 'NOT_STARTED');
  assert.equal(hist[0]?.byAdminId, adminId);
  assert.equal(hist[0]?.candidateId, x.cand.id);
  // last round grants nothing
  assert.equal(await prisma.$transaction((tx) => grantNextRound(tx, id!, adminId)), null);

  assert.equal(await prisma.$transaction((tx) => revokeNextRound(tx, x.e1.id)), 'removed');
  assert.equal(await prisma.roundEntry.count({ where: { id: id! } }), 0);
  assert.equal(await prisma.candidateStatusHistory.count({ where: { roundEntryId: id! } }), 0);
  assert.equal(await prisma.roundEntry.count({ where: { id: x.e1.id } }), 1);
  assert.equal(await prisma.$transaction((tx) => revokeNextRound(tx, x.e1.id)), 'none');
});

test('qualification: revoke refuses 409 once the next round has an attempt', async () => {
  const x = await twoRoundExam('b');
  const adminId = (await prisma.adminUser.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } })).id;
  const id = (await prisma.$transaction((tx) => grantNextRound(tx, x.e1.id, adminId)))!;
  await prisma.examAttempt.create({
    data: {
      candidateId: x.cand.id,
      roundEntryId: id,
      status: 'IN_PROGRESS',
      startedAt: new Date(),
      endsAt: new Date(Date.now() + 3_600_000),
      activeSessionId: 's',
      startIp: '127.0.0.1',
      userAgent: 'test',
      maxMarks: 10,
    },
  });
  await assert.rejects(
    prisma.$transaction((tx) => revokeNextRound(tx, x.e1.id)),
    (e: { statusCode?: number; message?: string }) => {
      assert.equal(e.statusCode, 409);
      assert.equal(e.message, 'The candidate has already started the next round.');
      return true;
    },
  );
  assert.equal(await prisma.roundEntry.count({ where: { id } }), 1);
  assert.equal(await prisma.candidateStatusHistory.count({ where: { roundEntryId: id } }), 1);
});

test('qualification: a shortlist granted while add-round is in flight still gets the new round entry', async () => {
  const x = await twoRoundExam('c'); // rounds 1,2; e1 in round 1, SHORTLISTED later
  await prisma.roundEntry.update({ where: { id: x.e1.id }, data: { status: 'NOT_STARTED' } });
  const adminId = (await prisma.adminUser.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } })).id;
  // make round 2 the last round for this scenario: move the person's shortlist to round 2, then add round 3
  const e2 = await prisma.roundEntry.create({ data: { registrationId: x.reg.id, roundId: x.r2.id } });

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const hasLock = new Promise<void>((r) => (locked = r));

  // Connection A: add round 3 (holds exam FOR UPDATE, round 3 uncommitted), waits at the gate.
  const adder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM exams WHERE id = ${x.exam.id}::uuid FOR UPDATE`;
    const r3 = await tx.examRound.create({ data: { examId: x.exam.id, roundNumber: 3 } });
    locked();
    await gate;
    const n = await backfillNewRound(tx, r3.id, adminId);
    return { r3, n };
  });
  await hasLock;

  // Connection B: shortlist e2 and grant. Must queue on the exam row until A commits.
  const shortlister = prisma.$transaction(async (tx) => {
    await tx.roundEntry.update({ where: { id: e2.id }, data: { status: 'SHORTLISTED' } });
    return grantNextRound(tx, e2.id, adminId);
  });
  await new Promise((r) => setTimeout(r, 300));
  release();
  const [{ r3 }, granted] = await Promise.all([adder, shortlister]);
  assert.ok(granted, 'grant must see the committed round 3');
  const e3 = await prisma.roundEntry.findFirst({ where: { registrationId: x.reg.id, roundId: r3.id } });
  assert.ok(e3, 'shortlisted person has a round 3 entry');
  assert.equal(e3?.id, granted);
});
