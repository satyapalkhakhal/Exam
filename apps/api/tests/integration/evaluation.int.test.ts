// Evaluation, decisions, leaderboard, dashboard and exports end to end against
// exam_test: the soft lock between two evaluators, draft and submit rules,
// blind payloads, Super-Admin-only decisions/reopen/leaderboard/exports, and
// the tie-break by submit time. Other suites may run at the same time, so this
// file only creates uniquely named rows and never truncates or flushes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import ExcelJS from 'exceljs';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createCandidate } from './helpers.js';
import { createApp } from '../../src/app.js';
import { closeEmailQueue, emailJobId, getEmailQueue } from '../../src/infrastructure/queue/email.queue.js';
import { EMAIL_KEY } from '../../src/modules/messaging/index.js';
import { systemConfig } from '../../src/modules/systemConfig/index.js';
import { createDispatchProcessor, emailsRepository } from '../../src/modules/emails/index.js';

const RUN = crypto.randomBytes(4).toString('hex');
const PASS = 'eval-int-pass-123';
const admins = {
  sa: { email: `sa-${RUN}@eval.int.test`, name: `Eval SA ${RUN}`, role: 'SUPER_ADMIN' },
  a: { email: `ea-${RUN}@eval.int.test`, name: `Evaluator Asha ${RUN}`, role: 'EVALUATOR' },
  b: { email: `eb-${RUN}@eval.int.test`, name: `Evaluator Bala ${RUN}`, role: 'EVALUATOR' },
} as const;
type Who = keyof typeof admins;

let app: Express;
const agents = {} as Record<Who, request.Agent>;
const adminIds = {} as Record<Who, string>;
let roleId = '';
let boardRoleId = '';
let questionIds: string[] = [];
let attemptId = '';
let candidateId = '';
let aqIds: string[] = [];
const board: Record<string, { candidateId: string; attemptId: string; aqIds: string[] }> = {};

const mobile = () => `9${crypto.randomInt(100_000_000, 999_999_999)}`;

async function signIn(who: Who) {
  const stale = await getRedis().keys('exam:rl:*');
  if (stale.length > 0) await getRedis().del(...stale);
  const agent = request.agent(app);
  const login = await agent.post('/api/admin/auth/login').send({ email: admins[who].email, password: PASS });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const verify = await agent.post('/api/admin/auth/verify-otp').send({ challengeId: login.body.data.challengeId, code: '123456' });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  return agent;
}

/** A candidate with a submitted attempt over the role's questions. */
async function submittedCandidate(key: string, jobRoleId: string, qs: { id: string; text: string; max: number }[], submittedAt: Date, fullName = `Cand ${key} ${RUN}`) {
  const c = await createCandidate({
    candidateCode: `EV-${RUN}-${key}`,
    fullName,
    email: `${key}-${RUN}@eval.int.test`,
    mobile: mobile(),
    rollNumber: `R-${RUN}-${key}`,
    majorCpi: 8.5,
    jobRoleId,
    status: 'SUBMITTED',
  });
  const a = await prisma.examAttempt.create({
    data: {
      candidateId: c.id,
      status: 'SUBMITTED',
      startedAt: new Date(submittedAt.getTime() - 40 * 60_000),
      endsAt: new Date(submittedAt.getTime() + 20 * 60_000),
      submittedAt,
      submitType: 'MANUAL',
      activeSessionId: crypto.randomUUID(),
      startIp: '198.51.100.20',
      userAgent: 'int-test',
      maxMarks: qs.reduce((t, q) => t + q.max, 0),
      questions: {
        create: qs.map((q, i) => ({
          questionId: q.id,
          order: i + 1,
          textSnapshot: q.text,
          maxMarksSnapshot: q.max,
          answer: { create: { text: `Answer ${i + 1} by ${key}`, wordCount: 4 } },
        })),
      },
    },
    include: { questions: { orderBy: { order: 'asc' } } },
  });
  return { candidateId: c.id, attemptId: a.id, aqIds: a.questions.map((q) => q.id) };
}

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  assert.match(env.REDIS_URL, /\/15$/);
  const hash = await bcrypt.hash(PASS, 4);
  for (const who of Object.keys(admins) as Who[]) {
    const a = admins[who];
    adminIds[who] = (await prisma.adminUser.create({ data: { email: a.email, name: a.name, role: a.role, passwordHash: hash } })).id;
  }
  const role = await prisma.jobRole.create({ data: { name: `Eval Role ${RUN}`, refApplicantCount: 40, examSetting: { create: {} } } });
  roleId = role.id;
  const q1 = await prisma.question.create({
    data: { jobRoleId: roleId, text: 'Explain idempotency.', normalizedTextHash: `e1-${RUN}`, maxMarks: 10, evaluatorGuidance: 'Mentions retries', displayOrder: 1 },
  });
  const q2 = await prisma.question.create({
    data: { jobRoleId: roleId, text: 'Explain backpressure.', normalizedTextHash: `e2-${RUN}`, maxMarks: 5, displayOrder: 2 },
  });
  questionIds = [q1.id, q2.id];
  const qs = [
    { id: q1.id, text: q1.text, max: 10 },
    { id: q2.id, text: q2.text, max: 5 },
  ];
  const m = await submittedCandidate('m', roleId, qs, new Date(Date.now() - 3_600_000), `=HYPERLINK("http://x") ${RUN}`);
  ({ attemptId, candidateId, aqIds } = m);
  await prisma.activityLog.createMany({
    data: [
      { candidateId, attemptId, eventType: 'PASTE_ATTEMPT', questionId: aqIds[0]!, ip: '198.51.100.20' },
      { candidateId, attemptId, eventType: 'SUSPICIOUS_BULK_INSERT', questionId: aqIds[0]!, ip: '198.51.100.20', metadata: { grown: 300, typed: 2, rate: 0 } },
    ],
  });
  await prisma.candidateLoginLog.create({
    data: { candidateId, stage: 'EXAM_START', permission: 'GRANTED', latitude: 26.1, longitude: 91.7, ip: '198.51.100.20', userAgent: 'x', browser: 'x', os: 'x', deviceType: 'desktop' },
  });
  await createCandidate({ candidateCode: `EV-${RUN}-ns`, fullName: 'Not Started', email: `ns-${RUN}@eval.int.test`, jobRoleId: roleId });

  // Leaderboard role: tied totals separated by submit time.
  const bRole = await prisma.jobRole.create({ data: { name: `Eval Board ${RUN}`, examSetting: { create: {} } } });
  boardRoleId = bRole.id;
  const bq = await prisma.question.create({ data: { jobRoleId: boardRoleId, text: 'Board Q', normalizedTextHash: `b1-${RUN}`, maxMarks: 10 } });
  const base = Date.now() - 10 * 3_600_000;
  for (const [key, total, offsetMin] of [['late', 8, 30], ['early', 8, 10], ['top', 9, 60]] as const) {
    const s = await submittedCandidate(key, boardRoleId, [{ id: bq.id, text: 'Board Q', max: 10 }], new Date(base + offsetMin * 60_000));
    await prisma.questionEvaluation.create({ data: { attemptQuestionId: s.aqIds[0]!, marks: total, evaluatorId: adminIds.sa } });
    await prisma.attemptEvaluation.create({ data: { attemptId: s.attemptId, status: 'SUBMITTED', evaluatorId: adminIds.sa, submittedAt: new Date() } });
    await prisma.examAttempt.update({ where: { id: s.attemptId }, data: { totalMarks: total, percentage: total * 10 } });
    await prisma.candidate.update({ where: { id: s.candidateId }, data: { status: 'EVALUATED' } });
    board[key] = s;
  }
  await submittedCandidate('pending', boardRoleId, [{ id: bq.id, text: 'Board Q', max: 10 }], new Date(base));

  app = createApp();
  for (const who of Object.keys(admins) as Who[]) agents[who] = await signIn(who);
});

after(async () => {
  await prisma.systemConfig.deleteMany({ where: { key: EMAIL_KEY } });
  await closeEmailQueue();
  await prisma.$disconnect();
  await getRedis().quit();
});

const PII = ['fullName', 'email', 'mobile', 'rollNumber', 'majorCpi', 'xPercentage', 'xiiPercentage', 'programme', 'discipline', 'latitude', 'longitude', 'ip', 'candidateId'];
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.add(k), keysDeep(x, out));
  return out;
}

const save = (who: Who, items: { attemptQuestionId: string; marks: number | null; comment?: string | null }[], submit: boolean) =>
  agents[who].put(`/api/admin/submissions/${attemptId}/evaluation`).send({ items, submit });

test('submissions list: evaluator rows are blind and cannot be searched by name; SA rows carry PII', async () => {
  const ev = await agents.a.get(`/api/admin/submissions?jobRoleId=${roleId}`);
  assert.equal(ev.status, 200, JSON.stringify(ev.body));
  assert.equal(ev.body.data.total, 1);
  assert.equal(ev.body.data.page, 1);
  const row = ev.body.data.items[0];
  assert.equal(row.attemptId, attemptId);
  assert.equal(row.evaluationStatus, 'PENDING');
  assert.equal(row.timeTakenSec, 2400);
  assert.deepEqual(PII.filter((k) => keysDeep(ev.body).has(k)), []);
  assert.equal(row.flagCounts.pasteAttempts, 1);
  assert.equal(row.flagCounts.bulkInsert, 1);

  const byName = await agents.a.get(`/api/admin/submissions?search=${encodeURIComponent(`HYPERLINK("http://x") ${RUN}`)}`);
  assert.equal(byName.body.data.total, 0);
  const byCode = await agents.a.get(`/api/admin/submissions?search=EV-${RUN}-m`);
  assert.equal(byCode.body.data.total, 1);

  const sa = await agents.sa.get(`/api/admin/submissions?search=${encodeURIComponent(`HYPERLINK("http://x") ${RUN}`)}`);
  assert.equal(sa.body.data.total, 1);
  assert.equal(sa.body.data.items[0].candidateId, candidateId);
  assert.ok(sa.body.data.items[0].fullName.includes('HYPERLINK'));
  assert.equal(sa.body.data.items[0].latitude, undefined);
});

test('evaluator A locks; evaluator B is refused with 423 naming A, but can still read the marking view', async () => {
  const lock = await agents.a.post(`/api/admin/submissions/${attemptId}/lock`);
  assert.equal(lock.status, 200, JSON.stringify(lock.body));
  assert.deepEqual(lock.body.data.lockedBy, { id: adminIds.a, name: admins.a.name });
  assert.ok(lock.body.data.lockedAt);

  const again = await agents.a.post(`/api/admin/submissions/${attemptId}/lock`);
  assert.equal(again.status, 200);

  const other = await agents.b.post(`/api/admin/submissions/${attemptId}/lock`);
  assert.equal(other.status, 423);
  assert.equal(other.body.error.code, 'EVALUATION_LOCKED');
  assert.deepEqual(other.body.error.details.lockedBy, { id: adminIds.a, name: admins.a.name });
  assert.ok(other.body.error.message.includes(admins.a.name));

  const view = await agents.b.get(`/api/admin/submissions/${attemptId}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.deepEqual(PII.filter((k) => keysDeep(view.body).has(k)), []);
  assert.equal(view.body.data.questions.length, 2);
  const q1 = view.body.data.questions[0];
  assert.equal(q1.evaluatorGuidance, 'Mentions retries');
  assert.equal(q1.answer.text, 'Answer 1 by m');
  assert.equal(q1.integrity.pasteAttempts, 1);
  assert.deepEqual(q1.integrity.bulkInsert.map((b: { grown: number; typed: number }) => [b.grown, b.typed]), [[300, 2]]);

  const blocked = await agents.b.put(`/api/admin/submissions/${attemptId}/evaluation`).send({ items: [], submit: false });
  assert.equal(blocked.status, 423);
  assert.deepEqual(blocked.body.error.details.lockedBy, { id: adminIds.a, name: admins.a.name });

  const notMine = await agents.b.delete(`/api/admin/submissions/${attemptId}/lock`);
  assert.equal(notMine.status, 204);
  assert.equal((await agents.b.post(`/api/admin/submissions/${attemptId}/lock`)).status, 423);
});

test('a draft accepts null marks; out-of-range marks are MARKS_OUT_OF_RANGE with the question id', async () => {
  const draft = await save('a', [
    { attemptQuestionId: aqIds[0]!, marks: 7.5, comment: 'Good' },
    { attemptQuestionId: aqIds[1]!, marks: null, comment: '' },
  ], false);
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const list = await agents.a.get(`/api/admin/submissions?jobRoleId=${roleId}&evaluation=DRAFT`);
  assert.equal(list.body.data.total, 1);
  assert.equal((await agents.a.get(`/api/admin/submissions?jobRoleId=${roleId}&evaluation=PENDING`)).body.data.total, 0);

  const bad = await save('a', [{ attemptQuestionId: aqIds[1]!, marks: 5.5 }], false);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'MARKS_OUT_OF_RANGE');
  assert.equal(bad.body.error.details.attemptQuestionId, aqIds[1]);

  const foreign = await save('a', [{ attemptQuestionId: board.top!.aqIds[0]!, marks: 1 }], false);
  assert.equal(foreign.status, 400);
});

const markRow = (aq: string) => prisma.questionEvaluation.findUnique({ where: { attemptQuestionId: aq } });

test('a draft comment without marks persists; an omitted comment is kept; an empty one clears', async () => {
  const r1 = await save('a', [{ attemptQuestionId: aqIds[1]!, marks: null, comment: 'Needs work' }], false);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  let view = await agents.a.get(`/api/admin/submissions/${attemptId}`);
  assert.deepEqual(view.body.data.questions[1].evaluation, { marks: null, comment: 'Needs work' });

  // marks change, comment omitted: the stored comment stays
  assert.equal((await save('a', [{ attemptQuestionId: aqIds[0]!, marks: 6 }], false)).status, 200);
  assert.equal((await markRow(aqIds[0]!))?.comment, 'Good');
  // marks null, comment omitted: comment-only row stays
  assert.equal((await save('a', [{ attemptQuestionId: aqIds[1]!, marks: null }], false)).status, 200);
  view = await agents.a.get(`/api/admin/submissions/${attemptId}`);
  assert.deepEqual(view.body.data.questions[1].evaluation, { marks: null, comment: 'Needs work' });
  // explicit null clears a comment; with no marks the row goes away
  assert.equal((await save('a', [{ attemptQuestionId: aqIds[0]!, marks: 7.5, comment: null }], false)).status, 200);
  assert.equal((await markRow(aqIds[0]!))?.comment, null);
  assert.equal((await save('a', [{ attemptQuestionId: aqIds[0]!, marks: 7.5, comment: 'Good' }], false)).status, 200);
});

test('submit with a missing question is 400', async () => {
  // aqIds[1] has a comment-only row: that still counts as unmarked
  const res = await save('a', [{ attemptQuestionId: aqIds[0]!, marks: 7.5 }], true);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body.error.details.missing, [aqIds[1]]);
  assert.equal((await save('a', [{ attemptQuestionId: aqIds[1]!, marks: null, comment: '' }], false)).status, 200);
  assert.equal(await markRow(aqIds[1]!), null);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } })).status, 'SUBMITTED');
});

test('submit complete: totals computed, candidate EVALUATED with history, audited, lock released', async () => {
  const res = await save('a', [
    { attemptQuestionId: aqIds[0]!, marks: 7.5, comment: 'Good' },
    { attemptQuestionId: aqIds[1]!, marks: 2 },
  ], true);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { evaluationStatus: 'SUBMITTED', totalMarks: 9.5, maxMarks: 15, percentage: 63.33 });

  const c = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });
  assert.equal(c.status, 'EVALUATED');
  const h = await prisma.candidateStatusHistory.findFirstOrThrow({ where: { candidateId, toStatus: 'EVALUATED' } });
  assert.equal(h.fromStatus, 'SUBMITTED');
  assert.equal(h.byAdminId, adminIds.a);
  const a = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  assert.equal(a.totalMarks?.toNumber(), 9.5);
  assert.equal(a.percentage?.toNumber(), 63.33);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'EVALUATION_SUBMITTED', entityId: attemptId, adminId: adminIds.a } }), 1);

  const again = await save('a', [{ attemptQuestionId: aqIds[1]!, marks: 3 }], false);
  assert.equal(again.status, 409);
  // the lock was released on submit, and a submitted evaluation cannot be locked again; it stays readable
  const relock = await agents.b.post(`/api/admin/submissions/${attemptId}/lock`);
  assert.equal(relock.status, 409);
  assert.equal(relock.body.error.code, 'CONFLICT');
  assert.equal((await prisma.attemptEvaluation.findUniqueOrThrow({ where: { attemptId } })).lockedById, null);
  assert.equal((await agents.b.get(`/api/admin/submissions/${attemptId}`)).status, 200);
});

test('an Evaluator calling decision, reopen, leaderboard or exports is 403', async () => {
  const d = await agents.a.post(`/api/admin/candidates/${candidateId}/decision`).send({ decision: 'SHORTLISTED' });
  assert.equal(d.status, 403);
  assert.equal((await agents.a.post(`/api/admin/submissions/${attemptId}/reopen`).send({ reason: 'x' })).status, 403);
  assert.equal((await agents.a.get(`/api/admin/leaderboard?jobRoleId=${roleId}`)).status, 403);
  assert.equal((await agents.a.get('/api/admin/exports/results.xlsx')).status, 403);
  assert.equal((await agents.a.get('/api/admin/exports/activity.xlsx')).status, 403);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } })).status, 'EVALUATED');
});

test('SA decision: shortlist from EVALUATED sets result, keeps status, with history; refused from a non-evaluated status', async () => {
  const d = await agents.sa.post(`/api/admin/candidates/${candidateId}/decision`).send({ decision: 'SHORTLISTED', comment: 'Strong' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const row = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });
  assert.deepEqual({ status: row.status, result: row.result, by: row.resultById }, { status: 'EVALUATED', result: 'SHORTLISTED', by: adminIds.sa });
  assert.ok(row.resultAt);
  const h = await prisma.candidateStatusHistory.findFirstOrThrow({ where: { candidateId, toResult: 'SHORTLISTED' } });
  assert.deepEqual({ fromStatus: h.fromStatus, toStatus: h.toStatus, fromResult: h.fromResult }, { fromStatus: 'EVALUATED', toStatus: 'EVALUATED', fromResult: null });
  assert.equal(h.comment, 'Strong');
  assert.equal((await agents.sa.post(`/api/admin/candidates/${candidateId}/decision`).send({ decision: 'SHORTLISTED' })).status, 409);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_DECISION', entityId: candidateId } }), 1);

  const pending = await prisma.candidate.findUniqueOrThrow({ where: { candidateCode: `EV-${RUN}-pending` } });
  const refused = await agents.sa.post(`/api/admin/candidates/${pending.id}/decision`).send({ decision: 'REJECTED' });
  assert.equal(refused.status, 409);
});

test('leaderboard: evaluated only, by total desc then submittedAt asc, with rank, PII and per-question marks', async () => {
  const res = await agents.sa.get(`/api/admin/leaderboard?jobRoleId=${boardRoleId}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const items = res.body.data.items as { rank: number; candidateId: string; fullName: string; totalMarks: number; percentage: number; questionMarks: unknown[]; result: string | null }[];
  assert.ok(items.every((i) => i.result === null));
  assert.deepEqual(items.map((i) => i.candidateId), [board.top!.candidateId, board.early!.candidateId, board.late!.candidateId]);
  assert.deepEqual(items.map((i) => i.rank), [1, 2, 3]);
  assert.equal(items[0]!.totalMarks, 9);
  assert.ok(items[0]!.fullName);
  assert.deepEqual(items[0]!.questionMarks, [{ order: 1, marks: 9, maxMarks: 10 }]);
});

test('SA reopen: evaluation back to DRAFT, candidate back to the submitted status, logged', async () => {
  const res = await agents.sa.post(`/api/admin/submissions/${attemptId}/reopen`).send({ reason: 'Recheck Q2' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await prisma.attemptEvaluation.findUniqueOrThrow({ where: { attemptId } })).status, 'DRAFT');
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } })).status, 'SUBMITTED');
  const h = await prisma.candidateStatusHistory.findFirstOrThrow({ where: { candidateId, toStatus: 'SUBMITTED' } });
  assert.equal(h.fromStatus, 'EVALUATED');
  assert.equal(h.comment, 'Recheck Q2');
  // reopen clears the result (it was SHORTLISTED by the decision test)
  const after = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });
  assert.deepEqual({ result: after.result, at: after.resultAt, by: after.resultById }, { result: null, at: null, by: null });
  assert.deepEqual({ fromResult: h.fromResult, toResult: h.toResult }, { fromResult: 'SHORTLISTED', toResult: null });
  const reopenAudit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'EVALUATION_REOPENED', entityId: attemptId } });
  assert.equal((reopenAudit.metadata as { clearedResult: string | null }).clearedResult, 'SHORTLISTED');
  const late = await agents.sa.post('/api/admin/candidates/bulk/result').send({ candidateIds: [candidateId], decision: 'REJECTED', sendEmail: false });
  assert.deepEqual(late.body.data.skipped.map((x: { reason: string }) => x.reason), ['NOT_EVALUATED']);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'EVALUATION_REOPENED', entityId: attemptId } }), 1);
  const view = await agents.sa.get(`/api/admin/submissions/${attemptId}`);
  assert.equal(view.body.data.evaluationStatus, 'DRAFT');
  assert.equal(view.body.data.questions[1].evaluation.marks, 2);
  assert.equal((await agents.sa.post(`/api/admin/submissions/${attemptId}/reopen`).send({ reason: 'again' })).status, 409);

  // nobody holds the lock now: a save without taking it is 423 with lockedBy null
  const unlocked = await save('a', [{ attemptQuestionId: aqIds[1]!, marks: 3 }], false);
  assert.equal(unlocked.status, 423);
  assert.equal(unlocked.body.error.details.lockedBy, null);
});

test('dashboard: per-role counts for any admin', async () => {
  for (const who of ['sa', 'a'] as const) {
    const res = await agents[who].get('/api/admin/dashboard');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const mine = res.body.data.roles.find((r: { jobRoleId: string }) => r.jobRoleId === roleId);
    assert.deepEqual(mine, {
      jobRoleId: roleId,
      jobRoleName: `Eval Role ${RUN}`,
      refApplicantCount: 40,
      imported: 2,
      notStarted: 1,
      inProgress: 0,
      submitted: 1,
      autoSubmitted: 0,
      evaluated: 0,
      shortlisted: 0,
      rejected: 0,
      pendingEvaluation: 1,
    });
    const b = res.body.data.roles.find((r: { jobRoleId: string }) => r.jobRoleId === boardRoleId);
    assert.equal(b.evaluated, 3);
    assert.equal(b.pendingEvaluation, 1);
  }
});

async function workbook(res: request.Response) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body as Buffer);
  return wb;
}
const binary = (r: request.Request) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

test('results.xlsx: one sheet per role, escaped strings, per-question marks', async () => {
  const res = await binary(agents.sa.get(`/api/admin/exports/results.xlsx?jobRoleId=${boardRoleId}`));
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /spreadsheetml/);
  assert.match(String(res.headers['content-disposition']), new RegExp(`^attachment; filename="results-eval-board-${RUN}-\\d{4}-\\d{2}-\\d{2}\\.xlsx"$`));
  const wb = await workbook(res);
  assert.equal(wb.worksheets.length, 1);
  const ws = wb.worksheets[0]!;
  const header = (ws.getRow(1).values as unknown[]).slice(1);
  assert.ok(header.includes('Q1 marks'));
  assert.ok(header.includes('Total'));
  assert.equal(ws.getRow(2).getCell(header.indexOf('Candidate code') + 1).value, `EV-${RUN}-top`);

  const all = await binary(agents.sa.get(`/api/admin/exports/results.xlsx?jobRoleId=${roleId}`));
  const ws2 = (await workbook(all)).worksheets[0]!;
  const h2 = (ws2.getRow(1).values as unknown[]).slice(1);
  const names = [2, 3].map((r) => ws2.getRow(r).getCell(h2.indexOf('Name') + 1).value);
  assert.ok(names.includes(`'=HYPERLINK("http://x") ${RUN}`), JSON.stringify(names));
  // the reopened (DRAFT) attempt shows no marks, totals or comments
  const mRow = [2, 3].map((r) => ws2.getRow(r)).find((row) => row.getCell(h2.indexOf('Candidate code') + 1).value === `EV-${RUN}-m`)!;
  for (const col of ['Q1 marks', 'Q2 marks', 'Total', 'Max', 'Percentage', 'Evaluator comments']) {
    assert.equal(mRow.getCell(h2.indexOf(col) + 1).value, null, col);
  }
  const top = ws.getRow(2);
  assert.equal(top.getCell(header.indexOf('Q1 marks') + 1).value, 9);
  assert.equal(top.getCell(header.indexOf('Max') + 1).value, 10);
});

test('activity.xlsx: integrity and location flags per candidate', async () => {
  const res = await binary(agents.sa.get(`/api/admin/exports/activity.xlsx?jobRoleId=${roleId}`));
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-disposition']), /^attachment; filename="activity-eval-role-/);
  const ws = (await workbook(res)).worksheets[0]!;
  const header = (ws.getRow(1).values as unknown[]).slice(1);
  const row = ws.getRow(2);
  assert.equal(row.getCell(header.indexOf('Paste/copy attempts') + 1).value, 1);
  assert.equal(row.getCell(header.indexOf('Bulk inserts') + 1).value, 1);
  assert.ok(!header.some((h) => /latitude|longitude/i.test(String(h))));
});

test('marking view for an unknown or not-submitted attempt is 404', async () => {
  assert.equal((await agents.a.get(`/api/admin/submissions/${crypto.randomUUID()}`)).status, 404);
  assert.equal((await agents.a.post(`/api/admin/submissions/${crypto.randomUUID()}/lock`)).status, 404);
  assert.ok(questionIds.length === 2);
});

// ---- final review fixes ---------------------------------------------------

async function freshSubmission(key: string) {
  const role = await prisma.jobRole.create({ data: { name: `Eval ${key} ${RUN}`, examSetting: { create: {} } } });
  const q = await prisma.question.create({ data: { jobRoleId: role.id, text: `Q ${key}`, normalizedTextHash: `${key}-${RUN}`, maxMarks: 10 } });
  return submittedCandidate(key, role.id, [{ id: q.id, text: q.text, max: 10 }], new Date(Date.now() - 60_000));
}

test('I9: the holder re-POSTing the lock extends it, so a long session keeps it', async () => {
  const s = await freshSubmission('renew');
  assert.equal((await agents.a.post(`/api/admin/submissions/${s.attemptId}/lock`)).status, 200);
  // 25 of the 30 minutes have passed without a draft save.
  const old = new Date(Date.now() - 25 * 60_000);
  await prisma.attemptEvaluation.update({ where: { attemptId: s.attemptId }, data: { lockedAt: old } });
  const renewed = await agents.a.post(`/api/admin/submissions/${s.attemptId}/lock`);
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  const row = await prisma.attemptEvaluation.findUniqueOrThrow({ where: { attemptId: s.attemptId } });
  assert.equal(row.lockedById, adminIds.a);
  assert.ok(row.lockedAt && Date.now() - row.lockedAt.getTime() < 60_000, 'lockedAt moved to now');
  assert.equal((await agents.b.post(`/api/admin/submissions/${s.attemptId}/lock`)).status, 423);
  await agents.a.delete(`/api/admin/submissions/${s.attemptId}/lock`);
});

test('T11#2: a reopen racing a decision records the decided result as "from", not a stale read', async () => {
  const s = await freshSubmission('race');
  assert.equal((await agents.sa.post(`/api/admin/submissions/${s.attemptId}/lock`)).status, 200);
  const sub = await agents.sa.put(`/api/admin/submissions/${s.attemptId}/evaluation`).send({ items: [{ attemptQuestionId: s.aqIds[0]!, marks: 6 }], submit: true });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));

  // A decision holds the candidate row while the reopen arrives.
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const decision = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${s.candidateId}::uuid FOR UPDATE`;
    await tx.candidate.update({ where: { id: s.candidateId }, data: { result: 'SHORTLISTED' } });
    await tx.candidateStatusHistory.create({
      data: { candidateId: s.candidateId, fromStatus: 'EVALUATED', toStatus: 'EVALUATED', toResult: 'SHORTLISTED', byAdminId: adminIds.sa },
    });
    locked();
    await new Promise((r) => setTimeout(r, 500));
  });
  await isLocked;
  const reopen = agents.sa.post(`/api/admin/submissions/${s.attemptId}/reopen`).send({ reason: 'race' });
  const [res] = await Promise.all([reopen, decision]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const h = await prisma.candidateStatusHistory.findFirstOrThrow({ where: { candidateId: s.candidateId, comment: 'race' } });
  assert.equal(h.fromResult, 'SHORTLISTED');
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'EVALUATION_REOPENED', entityId: s.attemptId } });
  assert.equal((audit.metadata as { clearedResult: string }).clearedResult, 'SHORTLISTED');
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: s.candidateId } })).result, null);
});

test('T11#2: submitting marks for an attempt that was reset meanwhile is refused and leaves the candidate alone', async () => {
  const s = await freshSubmission('resetrace');
  assert.equal((await agents.a.post(`/api/admin/submissions/${s.attemptId}/lock`)).status, 200);
  const reset = await agents.sa.post(`/api/admin/candidates/${s.candidateId}/reset-attempt`).send({ reason: 'tech issue' });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const sub = await agents.a.put(`/api/admin/submissions/${s.attemptId}/evaluation`).send({ items: [{ attemptQuestionId: s.aqIds[0]!, marks: 6 }], submit: true });
  assert.notEqual(sub.status, 200);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: s.candidateId } })).status, 'NOT_STARTED');
});

test('submissions search: a Super Admin also finds by roll number and email; an Evaluator cannot', async () => {
  const roll = `R-${RUN}-m`;
  const sa = await agents.sa.get(`/api/admin/submissions?search=${encodeURIComponent(roll)}`);
  assert.equal(sa.status, 200);
  assert.ok(sa.body.data.items.some((r: { candidateCode: string }) => r.candidateCode === `EV-${RUN}-m`), 'SA finds by roll number');
  const email = (await prisma.candidate.findUniqueOrThrow({ where: { candidateCode: `EV-${RUN}-m` } })).email;
  const saMail = await agents.sa.get(`/api/admin/submissions?search=${encodeURIComponent(email)}`);
  assert.ok(saMail.body.data.items.some((r: { candidateCode: string }) => r.candidateCode === `EV-${RUN}-m`), 'SA finds by email');
  const ev = await agents.a.get(`/api/admin/submissions?search=${encodeURIComponent(roll)}`);
  assert.equal(ev.body.data.items.length, 0, 'evaluator search stays code-only (blind marking)');
});

// ---- bulk shortlist / reject (2026-11-05) ------------------------------------

/** A submitted attempt that has been evaluated (6/10), candidate EVALUATED. */
async function evaluatedSubmission(key: string, jobRoleId: string, qId: string) {
  const s = await submittedCandidate(key, jobRoleId, [{ id: qId, text: 'Bulk Q', max: 10 }], new Date(Date.now() - 60_000));
  await prisma.questionEvaluation.create({ data: { attemptQuestionId: s.aqIds[0]!, marks: 6, evaluatorId: adminIds.sa } });
  await prisma.attemptEvaluation.create({ data: { attemptId: s.attemptId, status: 'SUBMITTED', evaluatorId: adminIds.sa, submittedAt: new Date() } });
  await prisma.examAttempt.update({ where: { id: s.attemptId }, data: { totalMarks: 6, percentage: 60 } });
  await prisma.candidate.update({ where: { id: s.candidateId }, data: { status: 'EVALUATED' } });
  return s;
}

const READY_EMAIL = { enabled: true, baseUrl: 'https://mail.example.test', sendMailToken: 'tok', fromAddress: 'noreply@example.test', fromName: 'X', replyTo: '' };

test('bulk result: shortlists evaluated, skips others, queues emails for the decided only', async () => {
  const role = await prisma.jobRole.create({ data: { name: `Eval Bulk ${RUN}`, examSetting: { create: {} } } });
  const q = await prisma.question.create({ data: { jobRoleId: role.id, text: 'Bulk Q', normalizedTextHash: `bulk-${RUN}`, maxMarks: 10 } });
  const one = await evaluatedSubmission('bulk1', role.id, q.id);
  const two = await evaluatedSubmission('bulk2', role.id, q.id);
  const already = await evaluatedSubmission('bulk3', role.id, q.id);
  await prisma.candidate.update({ where: { id: already.candidateId }, data: { result: 'SHORTLISTED' } });
  const notEvaluated = await submittedCandidate('bulk4', role.id, [{ id: q.id, text: 'Bulk Q', max: 10 }], new Date());
  await prisma.candidate.update({ where: { id: two.candidateId }, data: { eligible: false } });

  const off = await agents.sa.post('/api/admin/candidates/bulk/result').send({ candidateIds: [one.candidateId], decision: 'SHORTLISTED', sendEmail: true });
  assert.equal(off.status, 409);
  assert.equal(off.body.error.code, 'EMAIL_NOT_CONFIGURED');
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: one.candidateId } })).result, null);

  await systemConfig.setConfig(EMAIL_KEY, READY_EMAIL, adminIds.sa);
  try {
    const res = await agents.sa.post('/api/admin/candidates/bulk/result').send({
      candidateIds: [one.candidateId, two.candidateId, already.candidateId, notEvaluated.candidateId, crypto.randomUUID()],
      decision: 'SHORTLISTED',
      sendEmail: true,
      comment: 'Top batch',
      nextRound: { name: 'HR round' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.equal(d.updated, 2);
    assert.equal(d.emailsQueued, 1);
    assert.equal(d.emailError, null);
    assert.deepEqual(d.skipped.map((x: { reason: string }) => x.reason), ['ALREADY_DECIDED', 'NOT_EVALUATED', 'NOT_FOUND']);
    assert.deepEqual(d.emailSkipped.map((x: { candidateId: string; reason: string }) => [x.candidateId, x.reason]), [[two.candidateId, 'INELIGIBLE']]);

    const rows = await prisma.candidate.findMany({ where: { id: { in: [one.candidateId, two.candidateId] } } });
    assert.ok(rows.every((r) => r.result === 'SHORTLISTED' && r.status === 'EVALUATED'));
    const dispatches = await prisma.emailDispatch.findMany({ where: { candidateId: { in: [one.candidateId, two.candidateId, already.candidateId] } } });
    assert.deepEqual(dispatches.map((x) => [x.candidateId, x.template]), [[one.candidateId, 'SHORTLISTED']]);
    assert.match(dispatches[0]!.subject, /HR round/);
    assert.ok(await getEmailQueue().getJob(emailJobId(dispatches[0]!.id)));
    assert.equal(await prisma.adminAuditLog.count({ where: { action: 'CANDIDATE_DECISION', entityId: { in: [one.candidateId, two.candidateId] } } }), 2);

    // Switching to rejected sends the other email even though one was already sent.
    const flip = await agents.sa.post('/api/admin/candidates/bulk/result').send({ candidateIds: [one.candidateId], decision: 'REJECTED', sendEmail: true });
    assert.equal(flip.body.data.updated, 1);
    assert.equal(flip.body.data.emailsQueued, 1);
    const rejected = await prisma.emailDispatch.findFirstOrThrow({ where: { candidateId: one.candidateId, template: 'REJECTED' } });
    assert.match(rejected.subject, /Update on your application/);
    const h = await prisma.candidateStatusHistory.findFirstOrThrow({ where: { candidateId: one.candidateId, toResult: 'REJECTED' } });
    assert.equal(h.fromResult, 'SHORTLISTED');

    // The earlier Shortlisted email is still queued: the worker must drop it, and send the Rejected one.
    const sentTo: string[] = [];
    const worker = createDispatchProcessor({ repo: emailsRepository, sendEmail: async (p) => void sentTo.push(p.subject) });
    assert.equal(await worker(dispatches[0]!.id, { finalAttempt: false }), 'SKIPPED');
    const dropped = await prisma.emailDispatch.findUniqueOrThrow({ where: { id: dispatches[0]!.id } });
    assert.deepEqual({ status: dropped.status, error: dropped.error }, { status: 'FAILED', error: 'Not sent: the result changed before the email went out' });
    assert.equal(await worker(rejected.id, { finalAttempt: false }), 'SENT');
    assert.equal(sentTo.length, 1);

    // Dashboard: decided candidates count under their result, not under evaluated.
    const dash = await agents.sa.get('/api/admin/dashboard');
    const mine = dash.body.data.roles.find((r: { jobRoleId: string }) => r.jobRoleId === role.id);
    assert.deepEqual({ evaluated: mine.evaluated, shortlisted: mine.shortlisted, rejected: mine.rejected, submitted: mine.submitted }, { evaluated: 0, shortlisted: 2, rejected: 1, submitted: 1 });
  } finally {
    await prisma.systemConfig.deleteMany({ where: { key: EMAIL_KEY } });
  }
});

test('bulk result: an Evaluator is 403; without email nothing is queued', async () => {
  assert.equal((await agents.a.post('/api/admin/candidates/bulk/result').send({ candidateIds: [candidateId], decision: 'REJECTED', sendEmail: false })).status, 403);
  const role = await prisma.jobRole.create({ data: { name: `Eval Bulk2 ${RUN}`, examSetting: { create: {} } } });
  const q = await prisma.question.create({ data: { jobRoleId: role.id, text: 'Bulk Q', normalizedTextHash: `bulk2-${RUN}`, maxMarks: 10 } });
  const s = await evaluatedSubmission('bulk5', role.id, q.id);
  const res = await agents.sa.post('/api/admin/candidates/bulk/result').send({ candidateIds: [s.candidateId], decision: 'REJECTED', sendEmail: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual({ updated: res.body.data.updated, emailsQueued: res.body.data.emailsQueued }, { updated: 1, emailsQueued: 0 });
  assert.equal(await prisma.emailDispatch.count({ where: { candidateId: s.candidateId } }), 0);
});

test('results.xlsx has a Result column', async () => {
  const res = await binary(agents.sa.get(`/api/admin/exports/results.xlsx?jobRoleId=${boardRoleId}`));
  const ws = (await workbook(res)).worksheets[0]!;
  const header = (ws.getRow(1).values as unknown[]).slice(1);
  assert.equal(header[header.indexOf('Status') + 1], 'Result');
});

test('Super Admin views mask the candidate email (submissions, marking, leaderboard)', async () => {
  const full = (await prisma.candidate.findUniqueOrThrow({ where: { candidateCode: `EV-${RUN}-m` } })).email;
  const masked = /^[a-z0-9]\*\*\*\*[a-z0-9]@eval\.int\.test$/;
  const subs = await agents.sa.get(`/api/admin/submissions?search=${encodeURIComponent(full)}`);
  assert.equal(subs.body.data.items.length, 1, 'search still matches the full email');
  assert.match(subs.body.data.items[0].email, masked);
  const view = await agents.sa.get(`/api/admin/submissions/${attemptId}`);
  assert.match(view.body.data.email, masked);
  const board = await agents.sa.get(`/api/admin/leaderboard?jobRoleId=${boardRoleId}`);
  assert.ok(board.body.data.items.length > 0);
  for (const row of board.body.data.items) assert.match(row.email, masked);
  assert.ok(!JSON.stringify([subs.body, view.body, board.body]).includes(full));
});

test('nearbyCount on submissions, marking view and leaderboard; results.xlsx has a Nearby candidates column', async () => {
  const subs = await agents.sa.get(`/api/admin/submissions?search=${encodeURIComponent(`EV-${RUN}-m`)}`);
  assert.equal(typeof subs.body.data.items[0].nearbyCount, 'number', 'm has a granted start location');
  const evView = await agents.a.get(`/api/admin/submissions/${attemptId}`);
  assert.equal(typeof evView.body.data.nearbyCount, 'number', 'evaluators see the count too (not PII)');
  const board = await agents.sa.get(`/api/admin/leaderboard?jobRoleId=${boardRoleId}`);
  for (const row of board.body.data.items) assert.equal(row.nearbyCount, null, 'board candidates have no start location');
  const res = await binary(agents.sa.get(`/api/admin/exports/results.xlsx?jobRoleId=${roleId}`));
  const ws = (await workbook(res)).worksheets[0]!;
  const header = (ws.getRow(1).values as unknown[]).slice(1);
  assert.ok(header.includes('Nearby candidates'));
  const mRow = [2, 3].map((r) => ws.getRow(r)).find((row) => row.getCell(header.indexOf('Candidate code') + 1).value === `EV-${RUN}-m`)!;
  assert.equal(typeof mRow.getCell(header.indexOf('Nearby candidates') + 1).value, 'number');
});
