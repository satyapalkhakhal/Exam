// Job roles and exam settings end to end against exam_test: RBAC (any admin
// reads, only Super Admin writes), settings validation, auditing and the
// getSettings hand-off used by the exam engine.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createApp } from '../../src/app.js';
import { jobRoles } from '../../src/modules/jobRoles/index.js';

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
    'TRUNCATE TABLE admin_audit_logs, exam_settings, job_roles, admin_users RESTART IDENTITY CASCADE',
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

const settingsBody = {
  durationMinutes: 90,
  windowStart: '2026-11-10T04:00:00.000Z',
  windowEnd: '2026-11-10T10:00:00.000Z',
  instructions: 'Read carefully.',
  isOpen: true,
};

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
  assert.deepEqual(res.body.data.settings, {
    durationMinutes: 60,
    windowStart: null,
    windowEnd: null,
    instructions: '',
    isOpen: false,
    questionsLocked: false,
  });
  assert.deepEqual(res.body.data.counts, { questions: 0, candidates: 0 });
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

test('Evaluator PUT settings is 403; durationMinutes 5 is 400; bad window is 400', async () => {
  const role = await prisma.jobRole.findFirstOrThrow({ where: { name: 'Backend Engineer' } });
  const url = `/api/admin/roles/${role.id}/settings`;
  assert.equal((await evAgent.put(url).send(settingsBody)).status, 403);
  assert.equal((await saAgent.put(url).send({ ...settingsBody, durationMinutes: 5 })).status, 400);
  assert.equal((await saAgent.put(url).send({ ...settingsBody, durationMinutes: 241 })).status, 400);
  assert.equal((await saAgent.put(url).send({ ...settingsBody, instructions: 'x'.repeat(10_001) })).status, 400);
  assert.equal(
    (await saAgent.put(url).send({ ...settingsBody, windowEnd: settingsBody.windowStart })).status,
    400,
  );
  const unchanged = await prisma.examSetting.findUniqueOrThrow({ where: { jobRoleId: role.id } });
  assert.equal(unchanged.durationMinutes, 60);
});

test('Super Admin PUT settings persists, is audited, shows in list and getSettings; unknown role is 404', async () => {
  const role = await prisma.jobRole.findFirstOrThrow({ where: { name: 'Backend Engineer' } });
  const url = `/api/admin/roles/${role.id}/settings`;
  const res = await saAgent.put(url).send(settingsBody);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { ...settingsBody, questionsLocked: false });

  const listed = (await evAgent.get('/api/admin/roles')).body.data.find((r: { id: string }) => r.id === role.id);
  assert.equal(listed.settings.durationMinutes, 90);
  assert.equal(listed.settings.windowStart, '2026-11-10T04:00:00.000Z');

  const s = await jobRoles.getSettings(role.id);
  assert.equal(s?.durationMinutes, 90);
  assert.equal(s?.isOpen, true);
  assert.ok(s?.windowStart instanceof Date);

  const audited = await prisma.adminAuditLog.findMany({
    where: { adminId: superId, action: 'EXAM_SETTINGS_UPDATED', entityId: role.id },
  });
  assert.equal(audited.length, 1);
  assert.ok(!JSON.stringify(audited[0]?.metadata).includes('Read carefully'));

  const cleared = await saAgent.put(url).send({ ...settingsBody, windowStart: null, windowEnd: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.windowStart, null);

  assert.equal(
    (await saAgent.put('/api/admin/roles/00000000-0000-4000-8000-000000000000/settings').send(settingsBody)).status,
    404,
  );
});

test('counts reflect questions and candidates', async () => {
  const role = await prisma.jobRole.findFirstOrThrow({ where: { name: 'Backend Engineer' } });
  await prisma.question.create({
    data: { jobRoleId: role.id, text: 'Q1', normalizedTextHash: 'h1', maxMarks: 10 },
  });
  const listed = (await saAgent.get('/api/admin/roles')).body.data.find((r: { id: string }) => r.id === role.id);
  assert.deepEqual(listed.counts, { questions: 1, candidates: 0 });
});
