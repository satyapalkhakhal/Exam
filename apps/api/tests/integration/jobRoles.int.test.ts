// Job roles (job profiles) end to end against exam_test: RBAC (any admin reads,
// only Super Admin writes), Round 1 created with the role, counts. Round and
// drive settings are covered by drives.int.test.ts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createApp } from '../../src/app.js';

const SA = { email: 'super@roles.test', password: 'super-pass-123' };
const EV = { email: 'eval@roles.test', password: 'eval-pass-123' };
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
    'TRUNCATE TABLE admin_audit_logs, drives, colleges, exam_rounds, job_roles, admin_users RESTART IDENTITY CASCADE',
  );
  await getRedis().flushdb();
  const sa = await prisma.adminUser.create({
    data: { email: SA.email, name: 'Roles Super', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash(SA.password, 4) },
  });
  await prisma.adminUser.create({
    data: { email: EV.email, name: 'Roles Eval', role: 'EVALUATOR', passwordHash: await bcrypt.hash(EV.password, 4) },
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

test('unauthenticated is 401; any admin can list roles', async () => {
  assert.equal((await request(app).get('/api/admin/roles')).status, 401);
  const res = await evAgent.get('/api/admin/roles');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, []);
});

test('Super Admin creates a role with default settings; duplicate name is 409; evaluator is 403', async () => {
  assert.equal((await evAgent.post('/api/admin/roles').send({ name: 'Nope' })).status, 403);
  const res = await saAgent.post('/api/admin/roles').send({ name: 'Backend Engineer', refApplicantCount: 36 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.name, 'Backend Engineer');
  assert.equal(res.body.data.refApplicantCount, 36);
  assert.equal(res.body.data.active, true);
  assert.equal(res.body.data.type, 'PLACEMENT');
  assert.equal(res.body.data.rounds.length, 1);
  assert.deepEqual(
    { n: res.body.data.rounds[0].roundNumber, d: res.body.data.rounds[0].durationMinutes, l: res.body.data.rounds[0].questionsLocked, w: res.body.data.rounds[0].weights, drives: res.body.data.rounds[0].drives },
    { n: 1, d: 60, l: false, w: { exam: 70, x: 10, xii: 10, cpi: 10 }, drives: [] },
  );
  assert.deepEqual(res.body.data.counts, { candidates: 0 });
  assert.equal((await saAgent.post('/api/admin/roles').send({ name: 'Backend Engineer' })).status, 409);
  assert.equal((await saAgent.post('/api/admin/roles').send({ name: ' ' })).status, 400);
});

test('PATCH renames and deactivates; unknown id is 404; evaluator 403', async () => {
  const { id } = (await saAgent.post('/api/admin/roles').send({ name: 'Temp Role' })).body.data;
  assert.equal((await evAgent.patch(`/api/admin/roles/${id}`).send({ active: false })).status, 403);
  const res = await saAgent.patch(`/api/admin/roles/${id}`).send({ name: 'Temp Role 2', active: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.name, 'Temp Role 2');
  assert.equal(res.body.data.active, false);
  assert.equal(
    (await saAgent.patch('/api/admin/roles/00000000-0000-4000-8000-000000000000').send({ active: false })).status,
    404,
  );
  assert.equal((await saAgent.patch(`/api/admin/roles/${id}`).send({})).status, 400);
});

test('round question counts reflect questions', async () => {
  const role = await prisma.jobRole.findFirstOrThrow({ where: { name: 'Backend Engineer' } });
  const round = await prisma.examRound.findFirstOrThrow({ where: { jobRoleId: role.id, roundNumber: 1 } });
  await prisma.question.create({
    data: { roundId: round.id, text: 'Q1', normalizedTextHash: 'h1', maxMarks: 10 },
  });
  const listed = (await saAgent.get('/api/admin/roles')).body.data.find((r: { id: string }) => r.id === role.id);
  assert.deepEqual(listed.rounds[0].counts, { questions: 1 });
  assert.deepEqual(listed.counts, { candidates: 0 });
});
