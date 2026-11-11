// Candidate email templates and manual sending end to end against exam_test:
// Super Admin only, template save/reset, the EMAIL_NOT_CONFIGURED gate, skip
// reasons, queued dispatches with their BullMQ jobs, resend, and the worker
// processor with a fake mail sender (nothing leaves the machine).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { closeEmailQueue, emailJobId, getEmailQueue } from '../../src/infrastructure/queue/email.queue.js';
import { createApp } from '../../src/app.js';
import { createDispatchProcessor, emailsRepository } from '../../src/modules/emails/index.js';
import { EMAIL_KEY } from '../../src/modules/messaging/index.js';
import { systemConfig } from '../../src/modules/systemConfig/index.js';
import { createCandidate, createRoleWithDrive } from './helpers.js';

const SA = { email: 'super@mail.test', password: 'super-pass-123' };
const EV = { email: 'eval@mail.test', password: 'eval-pass-123' };
let app: Express;
let sa: request.Agent;
let ev: request.Agent;
let superId = '';
let submittedId = '';
let shortlistedId = '';
let pendingId = '';

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
    'TRUNCATE TABLE email_dispatches, system_configs, admin_audit_logs, exam_attempts, candidates, candidate_accounts, drives, colleges, exam_rounds, job_roles, admin_users RESTART IDENTITY CASCADE',
  );
  await getRedis().flushdb();
  const admins = await Promise.all(
    (
      [
        [SA, 'M Super', 'SUPER_ADMIN'],
        [EV, 'M Eval', 'EVALUATOR'],
      ] as const
    ).map(async ([c, name, role]) => prisma.adminUser.create({ data: { email: c.email, name, role, passwordHash: await bcrypt.hash(c.password, 4) } })),
  );
  superId = admins[0]!.id;
  const role = await createRoleWithDrive('Mail Role');
  const mk = (n: number, status: 'SUBMITTED' | 'EVALUATED' | 'NOT_STARTED', result: 'SHORTLISTED' | null = null) =>
    createCandidate({ candidateCode: `MAIL-000${n}`, fullName: `Mail Person ${n}`, email: `mail${n}@cands.test`, driveId: role.driveId, status, result });
  const [a, b, c] = await Promise.all([mk(1, 'SUBMITTED'), mk(2, 'EVALUATED', 'SHORTLISTED'), mk(3, 'NOT_STARTED')]);
  submittedId = a.id;
  shortlistedId = b.id;
  pendingId = c.id;
  for (const id of [submittedId, shortlistedId]) {
    await prisma.examAttempt.create({
      data: {
        candidateId: id,
        status: 'SUBMITTED',
        submitType: 'MANUAL',
        startedAt: new Date('2026-11-03T08:00:00Z'),
        endsAt: new Date('2026-11-03T09:00:00Z'),
        submittedAt: new Date('2026-11-03T08:35:00Z'),
        activeSessionId: 's',
        startIp: '127.0.0.1',
        userAgent: 'test',
        maxMarks: 10,
      },
    });
  }
  app = createApp();
  sa = await signIn(SA);
  ev = await signIn(EV);
});

after(async () => {
  // Later test files sign in with the static OTP, which only works while no channel is configured.
  await prisma.systemConfig.deleteMany({ where: { key: EMAIL_KEY } });
  await closeEmailQueue();
  await prisma.$disconnect();
  await getRedis().quit();
});

test('only a Super Admin reaches the email routes', async () => {
  assert.equal((await ev.get('/api/admin/email-templates')).status, 403);
  assert.equal((await ev.post('/api/admin/emails/send').send({})).status, 403);
  assert.equal((await request(app).get('/api/admin/emails')).status, 401);
});

test('templates: defaults, save, unknown placeholder rejected, reset', async () => {
  const list = await sa.get('/api/admin/email-templates');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(list.body.data.templates.every((t: { isDefault: boolean }) => t.isDefault));
  assert.deepEqual(list.body.data.templates.map((t: { key: string }) => t.key), ['SUBMISSION_RECEIVED', 'SHORTLISTED', 'REJECTED']);

  const bad = await sa.put('/api/admin/email-templates/SUBMISSION_RECEIVED').send({ subject: 'Hi', body: 'Hello {nope}' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  assert.match(bad.body.error.message, /\{nope\}/);

  const saved = await sa.put('/api/admin/email-templates/SUBMISSION_RECEIVED').send({ subject: 'Received {role}', body: 'Hi {firstName}' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.isDefault, false);
  assert.equal(saved.body.data.updatedByName, 'M Super');

  const preview = await sa.post('/api/admin/email-templates/SUBMISSION_RECEIVED/preview').send({});
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.subject, 'Received Mail Role');

  const reset = await sa.post('/api/admin/email-templates/SUBMISSION_RECEIVED/reset');
  assert.equal(reset.body.data.isDefault, true);

  const audits = await prisma.adminAuditLog.findMany({ where: { action: { startsWith: 'EMAIL_TEMPLATE_' } }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(audits.map((a) => a.action), ['EMAIL_TEMPLATE_UPDATED', 'EMAIL_TEMPLATE_RESET']);
});

test('send answers 409 EMAIL_NOT_CONFIGURED until the email integration is ready', async () => {
  const res = await sa.post('/api/admin/emails/send').send({ template: 'SUBMISSION_RECEIVED', candidateIds: [submittedId] });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'EMAIL_NOT_CONFIGURED');
});

test('send queues dispatches and jobs, skips with reasons, blocks repeats until resend, and the worker delivers', async () => {
  await systemConfig.setConfig(
    EMAIL_KEY,
    { enabled: true, baseUrl: 'https://mail.example.test', sendMailToken: 'tok', fromAddress: 'noreply@example.test', fromName: 'X', replyTo: '' },
    superId,
  );
  const body = { template: 'SUBMISSION_RECEIVED', candidateIds: [submittedId, shortlistedId, pendingId] };
  const first = await sa.post('/api/admin/emails/send').send(body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.queued, 2);
  assert.deepEqual(first.body.data.skipped.map((s: { reason: string }) => s.reason), ['NOT_SUBMITTED']);

  const rows = await prisma.emailDispatch.findMany({ where: { batchId: first.body.data.batchId } });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'QUEUED' && r.html.includes('<table') && r.sentById === superId));
  for (const r of rows) assert.ok(await getEmailQueue().getJob(emailJobId(r.id)));

  const second = await sa.post('/api/admin/emails/send').send(body);
  assert.equal(second.body.data.queued, 0);
  assert.equal(second.body.data.skipped.filter((s: { reason: string }) => s.reason === 'ALREADY_SENT').length, 2);
  const again = await sa.post('/api/admin/emails/send').send({ ...body, resend: true });
  assert.equal(again.body.data.queued, 2);

  const sentTo: string[] = [];
  const process = createDispatchProcessor({ repo: emailsRepository, sendEmail: async (p) => void sentTo.push(p.to) });
  assert.equal(await process(rows[0]!.id, { finalAttempt: false }), 'SENT');
  assert.equal(await process(rows[0]!.id, { finalAttempt: false }), 'SKIPPED');
  assert.equal(sentTo.length, 1);
  const done = await prisma.emailDispatch.findUniqueOrThrow({ where: { id: rows[0]!.id } });
  assert.equal(done.status, 'SENT');
  assert.ok(done.sentAt);

  const failing = createDispatchProcessor({ repo: emailsRepository, sendEmail: async () => Promise.reject(new Error('provider down')) });
  await assert.rejects(failing(rows[1]!.id, { finalAttempt: false }), /provider down/);
  assert.equal((await prisma.emailDispatch.findUniqueOrThrow({ where: { id: rows[1]!.id } })).status, 'QUEUED');
  await assert.rejects(failing(rows[1]!.id, { finalAttempt: true }), /provider down/);
  const failed = await prisma.emailDispatch.findUniqueOrThrow({ where: { id: rows[1]!.id } });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error, 'provider down');

  const list = await sa.get(`/api/admin/emails?status=FAILED&batchId=${first.body.data.batchId}`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.data.total, 1);
  assert.equal(list.body.data.items[0].error, 'provider down');
  assert.equal(list.body.data.items[0].sentByName, 'M Super');
  assert.match(list.body.data.items[0].toEmail, /^m\*\*\*\*[0-9]@cands\.test$/, 'the recipient is masked in the list');
});

test('shortlisted emails go only to candidates whose result is SHORTLISTED', async () => {
  const res = await sa.post('/api/admin/emails/send').send({
    template: 'SHORTLISTED',
    candidateIds: [submittedId, shortlistedId],
    nextRound: { name: 'Technical interview', link: 'https://meet.example.test/abc' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.queued, 1);
  assert.deepEqual(res.body.data.skipped.map((s: { reason: string }) => s.reason), ['NOT_SHORTLISTED']);
});
