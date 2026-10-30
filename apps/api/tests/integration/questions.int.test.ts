// Questions end to end against exam_test: CRUD, import preview/confirm with the
// duplicate-file guard, the lock (423) and its Super Admin-only unlock.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createApp } from '../../src/app.js';

const SA = { email: 'super@questions.test', password: 'super-pass-123' };
const SA2 = { email: 'super2@questions.test', password: 'super-pass-456' };
const EV = { email: 'eval@questions.test', password: 'eval-pass-123' };
let app: Express;
let sa: request.Agent;
let sa2: request.Agent;
let ev: request.Agent;
let roleId = '';
let role2Id = '';

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
    'TRUNCATE TABLE admin_audit_logs, import_batches, questions, exam_settings, job_roles, admin_users RESTART IDENTITY CASCADE',
  );
  await getRedis().flushdb();
  for (const [c, name, role] of [
    [SA, 'Q Super', 'SUPER_ADMIN'],
    [SA2, 'Q Super Two', 'SUPER_ADMIN'],
    [EV, 'Q Eval', 'EVALUATOR'],
  ] as const) {
    await prisma.adminUser.create({
      data: { email: c.email, name, role, passwordHash: await bcrypt.hash(c.password, 4) },
    });
  }
  roleId = (await prisma.jobRole.create({ data: { name: 'Q Role', examSetting: { create: {} } } })).id;
  role2Id = (await prisma.jobRole.create({ data: { name: 'Q Role Two', examSetting: { create: {} } } })).id;
  app = createApp();
  sa = await signIn(SA);
  sa2 = await signIn(SA2);
  ev = await signIn(EV);
});

after(async () => {
  await prisma.$disconnect();
  await getRedis().quit();
});

const csv = (rows: string[]) =>
  Buffer.from(['question_text,max_marks,evaluator_guidance,display_order', ...rows].join('\n'));

const preview = (agent: request.Agent, file: Buffer, jobRoleId: string, name = 'q.csv') =>
  agent.post('/api/admin/questions/import/preview').field('jobRoleId', jobRoleId).attach('file', file, name);

test('template.csv is served with the four columns', async () => {
  const res = await sa.get('/api/admin/questions/template.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/csv/);
  assert.match(res.text, /^question_text,max_marks,evaluator_guidance,display_order/);
});

test('sample.csv is served as a CSV attachment', async () => {
  const res = await sa.get('/api/admin/questions/sample.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/csv/);
  assert.match(res.headers['content-disposition'] ?? '', /questions-sample\.csv/);
  assert.match(res.text, /^question_text,max_marks,evaluator_guidance,display_order\n/);
});

test('import: preview then confirm inserts N rows; the same file again is 409 until forced', async () => {
  const file = csv([
    'Explain the CAP theorem with an example,10,Look for partition tolerance,',
    'Describe how an index speeds up a query,5,,',
    'bad row text here,7.3,,',
    'explain THE cap theorem with an example,10,,',
  ]);
  const p = await preview(sa, file, roleId);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.data.summary, { total: 4, valid: 2, errors: 1, duplicates: 1 });
  assert.equal(p.body.data.errors[0].field, 'max_marks');
  assert.deepEqual(p.body.data.duplicates, [{ row: 5, reason: 'IN_FILE' }]);
  assert.equal(p.body.data.valid[1].displayOrder, 2);
  assert.ok(await getRedis().get(`exam:import:${p.body.data.previewId}`));

  assert.equal((await ev.post('/api/admin/questions/import/confirm').send({ previewId: p.body.data.previewId })).status, 403);
  assert.equal((await sa2.post('/api/admin/questions/import/confirm').send({ previewId: p.body.data.previewId })).status, 403);

  const c = await sa.post('/api/admin/questions/import/confirm').send({ previewId: p.body.data.previewId });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(c.body.data, { imported: 2, skipped: 2 });
  assert.equal(await prisma.question.count({ where: { jobRoleId: roleId } }), 2);
  assert.equal(await prisma.importBatch.count({ where: { kind: 'QUESTIONS', jobRoleId: roleId } }), 1);

  const again = await preview(sa, file, roleId);
  assert.equal(again.body.data.summary.valid, 0);
  assert.equal(again.body.data.summary.duplicates, 3);
  const conflict = await sa.post('/api/admin/questions/import/confirm').send({ previewId: again.body.data.previewId });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'CONFLICT');
  assert.match(conflict.body.error.message, /^This file was already imported on /);

  const forced = await sa
    .post('/api/admin/questions/import/confirm')
    .send({ previewId: again.body.data.previewId, force: true });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.deepEqual(forced.body.data, { imported: 0, skipped: 4 });
  assert.equal(await prisma.question.count({ where: { jobRoleId: roleId } }), 2);
});

test('import: missing required column, bad extension and unknown preview', async () => {
  const noCol = await preview(sa, Buffer.from('question_text\nsome long enough text\n'), roleId);
  assert.equal(noCol.status, 400);
  const pdf = await preview(sa, Buffer.from('x'), roleId, 'q.pdf');
  assert.equal(pdf.status, 400);
  const gone = await sa.post('/api/admin/questions/import/confirm').send({ previewId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(gone.status, 404);
  assert.equal((await ev.post('/api/admin/questions/import/preview').field('jobRoleId', roleId)).status, 403);
});

test('list returns the paged envelope with guidance for Evaluators too', async () => {
  const res = await ev.get(`/api/admin/questions?jobRoleId=${roleId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 2);
  assert.equal(res.body.data.page, 1);
  assert.equal(res.body.data.items[0].questionText, 'Explain the CAP theorem with an example');
  assert.equal(res.body.data.items[0].evaluatorGuidance, 'Look for partition tolerance');
  assert.equal(res.body.data.items[0].maxMarks, 10);
  assert.equal((await ev.get('/api/admin/questions')).status, 400);
});

test('create, duplicate 409, patch, deactivate and reorder', async () => {
  const body = { jobRoleId: role2Id, questionText: 'What is idempotency in HTTP?', maxMarks: 4, evaluatorGuidance: null };
  assert.equal((await ev.post('/api/admin/questions').send(body)).status, 403);
  const a = await sa.post('/api/admin/questions').send(body);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.data.displayOrder, 1);
  const dup = await sa.post('/api/admin/questions').send({ ...body, questionText: '  what is IDEMPOTENCY in http? ' });
  assert.equal(dup.status, 409);
  const b = await sa.post('/api/admin/questions').send({ ...body, questionText: 'Explain database transactions' });
  assert.equal(b.body.data.displayOrder, 2);

  const patched = await sa.patch(`/api/admin/questions/${a.body.data.id}`).send({ maxMarks: 6.5, questionText: 'What is idempotency in REST?' });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.data.maxMarks, 6.5);
  assert.equal((await sa.patch(`/api/admin/questions/${a.body.data.id}`).send({ maxMarks: 7.3 })).status, 400);
  const clash = await sa.patch(`/api/admin/questions/${a.body.data.id}`).send({ questionText: 'explain database transactions' });
  assert.equal(clash.status, 409);

  const off = await sa.patch(`/api/admin/questions/${b.body.data.id}/active`).send({ active: false });
  assert.equal(off.body.data.active, false);

  const order = await sa
    .patch(`/api/admin/roles/${role2Id}/questions/order`)
    .send({ ids: [b.body.data.id, a.body.data.id] });
  assert.equal(order.status, 200, JSON.stringify(order.body));
  const rows = await prisma.question.findMany({ where: { jobRoleId: role2Id }, orderBy: { displayOrder: 'asc' } });
  assert.deepEqual(rows.map((r) => r.id), [b.body.data.id, a.body.data.id]);
  const foreign = await sa.patch(`/api/admin/roles/${role2Id}/questions/order`).send({ ids: [b.body.data.id, (await prisma.question.findFirstOrThrow({ where: { jobRoleId: roleId } })).id] });
  assert.equal(foreign.status, 400);
});

test('locked role: every write is 423; unlock needs Super Admin, is audited, and re-opens writes', async () => {
  const q = await prisma.question.findFirstOrThrow({ where: { jobRoleId: roleId } });
  await prisma.examSetting.update({ where: { jobRoleId: roleId }, data: { questionsLocked: true } });

  assert.equal((await sa.patch(`/api/admin/questions/${q.id}`).send({ maxMarks: 3 })).status, 423);
  assert.equal((await sa.patch(`/api/admin/questions/${q.id}`).send({ maxMarks: 3 })).body.error.code, 'QUESTIONS_LOCKED');
  assert.equal((await sa.patch(`/api/admin/questions/${q.id}/active`).send({ active: false })).status, 423);
  assert.equal(
    (await sa.post('/api/admin/questions').send({ jobRoleId: roleId, questionText: 'A brand new locked question', maxMarks: 5 })).status,
    423,
  );
  assert.equal((await sa.patch(`/api/admin/roles/${roleId}/questions/order`).send({ ids: [q.id] })).status, 423);
  assert.equal((await preview(sa, csv(['Another question for locked role,5,,']), roleId)).status, 423);

  assert.equal((await ev.post(`/api/admin/roles/${roleId}/questions/unlock`).send({ reason: 'Fix a typo' })).status, 403);
  assert.equal((await sa.post(`/api/admin/roles/${roleId}/questions/unlock`).send({})).status, 400);
  const un = await sa.post(`/api/admin/roles/${roleId}/questions/unlock`).send({ reason: 'Fix a typo' });
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal(un.body.data.questionsLocked, false);
  assert.equal((await prisma.examSetting.findUniqueOrThrow({ where: { jobRoleId: roleId } })).questionsLocked, false);

  const log = await prisma.adminAuditLog.findFirst({ where: { action: 'QUESTIONS_UNLOCKED' } });
  assert.equal(log?.entityId, roleId);
  assert.equal((log?.metadata as { reason?: string }).reason, 'Fix a typo');

  assert.equal((await sa.patch(`/api/admin/questions/${q.id}`).send({ maxMarks: 3 })).status, 200);
});

test('a lock set in a concurrent transaction makes the waiting write 423 (row lock)', async () => {
  const q = await prisma.question.findFirstOrThrow({ where: { jobRoleId: roleId } });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const ready = new Promise<void>((r) => (locked = r));
  const starter = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM exam_settings WHERE job_role_id = ${roleId}::uuid FOR UPDATE`;
    await tx.examSetting.update({ where: { jobRoleId: roleId }, data: { questionsLocked: true } });
    locked();
    await held;
  });
  await ready;
  const write = sa.patch(`/api/admin/questions/${q.id}`).send({ maxMarks: 2 }).then((r) => r);
  await new Promise((r) => setTimeout(r, 300));
  release();
  await starter;
  const res = await write;
  assert.equal(res.status, 423, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'QUESTIONS_LOCKED');
  await prisma.examSetting.update({ where: { jobRoleId: roleId }, data: { questionsLocked: false } });
});
