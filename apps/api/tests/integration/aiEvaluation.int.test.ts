// AI-assisted evaluation end to end against exam_test (needs .env.test and a
// migrated database): run -> scores -> bulk accept -> leaderboard order, the
// exam-over gate, and reopen after an AI accept. The grader is a fake and the
// queue is replaced by direct calls to the processor, so neither OpenAI nor
// Redis queues are involved. Creates uniquely named rows only; never truncates.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createApp } from '../../src/app.js';
import { createCandidate, createDrive } from './helpers.js';
import { AI_DEFAULTS, type AiConfig } from '../../src/modules/aiEvaluation/aiEvaluation.config.js';
import { aiEvaluationRepository } from '../../src/modules/aiEvaluation/aiEvaluation.repository.js';
import { createAiEvaluationService } from '../../src/modules/aiEvaluation/aiEvaluation.service.js';
import type { AiGrader } from '../../src/modules/aiEvaluation/aiEvaluation.grader.js';

const RUN = crypto.randomBytes(4).toString('hex');
const PASS = 'ai-int-pass-123';
const SA_EMAIL = `sa-${RUN}@ai.int.test`;
const CFG: AiConfig = { ...AI_DEFAULTS, enabled: true, apiKey: 'sk-int-test', model: 'fake-model' };

let app: Express;
let sa: request.Agent;
let adminId = '';
/** Round 1 + the test drive of the AI role (spec 2026-11-10). */
let drive = { roundId: '', driveId: '', collegeId: '' };
let roleId = '';
let questionId = '';
const cands: Record<string, { candidateId: string; attemptId: string; aqId: string }> = {};
const enqueued: string[] = [];

// Marks the fake grader returns, by answer text.
const MARKS: Record<string, number> = { 'answer-good': 9, 'answer-ok': 6 };
const grader: AiGrader = {
  async grade(req) {
    const key = /answer-\w+/.exec(req.user)?.[0] ?? 'answer-ok';
    return {
      output: { marks: MARKS[key] ?? 5, rationale: 'r', strengths: ['s'], improvements: ['i'], confidence: key === 'answer-ok' ? 'LOW' : 'HIGH', concerns: [] },
      inputTokens: 50,
      outputTokens: 10,
      model: 'fake-model',
    };
  },
};
const ai = createAiEvaluationService({
  repo: aiEvaluationRepository,
  getConfig: async () => CFG,
  grader,
  enqueue: async (ids) => void enqueued.push(...ids),
  removeJobs: async () => {},
  audit: async () => {},
});

async function signIn() {
  const stale = await getRedis().keys('exam:rl:*');
  if (stale.length > 0) await getRedis().del(...stale);
  const agent = request.agent(app);
  const login = await agent.post('/api/admin/auth/login').send({ email: SA_EMAIL, password: PASS });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const verify = await agent.post('/api/admin/auth/verify-otp').send({ challengeId: login.body.data.challengeId, code: '123456' });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  return agent;
}

async function submitted(key: string, answer: string, submittedAt: Date) {
  const c = await createCandidate({
    candidateCode: `AI-${RUN}-${key}`,
    fullName: `Cand ${key} ${RUN}`,
    email: `${key}-${RUN}@ai.int.test`,
    xPercentage: 80,
    xiiPercentage: 80,
    majorCpi: 8,
    jobRoleId: roleId,
    driveId: drive.driveId,
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
      startIp: '198.51.100.30',
      userAgent: 'int-test',
      maxMarks: 10,
      questions: { create: [{ questionId, order: 1, textSnapshot: 'Explain idempotency.', maxMarksSnapshot: 10, answer: { create: { text: answer, wordCount: 1 } } }] },
    },
    include: { questions: true },
  });
  cands[key] = { candidateId: c.id, attemptId: a.id, aqId: a.questions[0]!.id };
}

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  assert.match(env.REDIS_URL, /\/15$/);
  adminId = (await prisma.adminUser.create({ data: { email: SA_EMAIL, name: `AI SA ${RUN}`, role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash(PASS, 4) } })).id;
  roleId = (await prisma.jobRole.create({ data: { name: `AI Role ${RUN}` } })).id;
  drive = await createDrive(roleId, { isOpen: true, college: 'AIC1', batch: 'Nov 2026' });
  questionId = (await prisma.question.create({ data: { roundId: drive.roundId, text: 'Explain idempotency.', normalizedTextHash: `ai-${RUN}`, maxMarks: 10, evaluatorGuidance: 'Mentions retries' } })).id;
  const base = Date.now() - 3_600_000;
  await submitted('good', 'answer-good', new Date(base));
  await submitted('ok', 'answer-ok', new Date(base + 60_000));
  app = createApp();
  sa = await signIn();
});

after(async () => {
  await prisma.$disconnect();
  await getRedis().quit();
});

const start = (input: Parameters<typeof ai.start>[0]) => ai.start(input, { id: adminId, ip: null });

test('exam-over gate: an open drive refuses a drive run; closing it allows one', async () => {
  await assert.rejects(() => start({ driveId: drive.driveId }), (e: unknown) => (e as { code?: string }).code === 'EXAM_NOT_OVER');
  await prisma.drive.update({ where: { id: drive.driveId }, data: { isOpen: false } });
  const r = await start({ driveId: drive.driveId });
  assert.equal(r.queued, 2);
  assert.equal(r.alreadyScored, 0);
});

test('processing the queued scores stores them, settles the run and exposes AI on the marking view', async () => {
  for (const id of enqueued) await ai.processScore(id, { finalAttempt: true });
  const [run] = await ai.list(drive.driveId);
  assert.equal(run!.status, 'DONE');
  assert.equal(run!.done, 2);
  assert.equal(run!.inputTokens, 100);

  const view = await sa.get(`/api/admin/submissions/${cands.good!.attemptId}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.data.questions[0].ai.marks, 9);
  assert.equal(view.body.data.ai.state, 'DONE');

  const again = await start({ driveId: drive.driveId });
  assert.deepEqual({ queued: again.queued, alreadyScored: again.alreadyScored, run: again.run }, { queued: 0, alreadyScored: 2, run: null });
});

test('bulk accept: the clean script is accepted, the LOW-confidence one is skipped; leaderboard ranks by composite', async () => {
  const res = await sa.post('/api/admin/submissions/ai/accept').send({ driveId: drive.driveId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.accepted, 1);
  assert.deepEqual(res.body.data.skipped.map((s: { reason: string }) => s.reason), ['LOW_CONFIDENCE']);

  const accepted = await prisma.examAttempt.findUniqueOrThrow({ where: { id: cands.good!.attemptId }, include: { questions: { include: { evaluation: true } } } });
  assert.equal(Number(accepted.totalMarks), 9);
  assert.ok(accepted.questions[0]!.evaluation?.aiScoreId);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: cands.good!.candidateId } })).status, 'EVALUATED');

  const board = await sa.get(`/api/admin/leaderboard?driveId=${drive.driveId}&sort=composite`);
  assert.equal(board.status, 200, JSON.stringify(board.body));
  const items = board.body.data.items as { candidateCode: string; compositeProvisional: boolean; compositeScore: number }[];
  assert.deepEqual(items.map((i) => i.candidateCode), [`AI-${RUN}-good`, `AI-${RUN}-ok`]);
  assert.equal(items[0]!.compositeProvisional, false);
  assert.equal(items[1]!.compositeProvisional, true);
  assert.ok(items[0]!.compositeScore > items[1]!.compositeScore);
});

test('reopen after an AI accept returns the script to draft and clears its totals', async () => {
  const r = await sa.post(`/api/admin/submissions/${cands.good!.attemptId}/reopen`).send({ reason: 'Re-check the marks' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = await prisma.examAttempt.findUniqueOrThrow({ where: { id: cands.good!.attemptId } });
  assert.equal(a.totalMarks, null);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: cands.good!.candidateId } })).status, 'SUBMITTED');
});


// ---- drives (spec 2026-11-10) -------------------------------------------------------

test('AI run with attempts from two drives → 400 MIXED_DRIVES; bulk accept too', async () => {
  const other = await createDrive(roleId, { college: 'AIC2', batch: 'Nov 2026' });
  await submitted('other', 'answer-other', new Date(Date.now() - 1_800_000));
  await prisma.candidate.update({ where: { id: cands.other!.candidateId }, data: { driveId: other.driveId } });
  const ids = [cands.good!.attemptId, cands.other!.attemptId];
  await assert.rejects(() => start({ attemptIds: ids }), (e: unknown) => (e as { code?: string }).code === 'MIXED_DRIVES');
  // (Over HTTP the app's own AI config is not set up here, so a run start answers AI_NOT_CONFIGURED first.)
  const acc = await sa.post('/api/admin/submissions/ai/accept').send({ attemptIds: ids });
  assert.equal(acc.status, 400);
  assert.equal(acc.body.error.code, 'MIXED_DRIVES');
});

test('AI run on drive refused while that drive is open, allowed while sibling drive is open', async () => {
  const role = await prisma.jobRole.create({ data: { name: `AI Sibling ${RUN}` } });
  const closed = await createDrive(role.id, { isOpen: false, college: 'AIC3', batch: 'Nov 2026' });
  const open = await createDrive(role.id, { isOpen: true, college: 'AIC4', batch: 'Nov 2026' });
  await assert.rejects(() => start({ driveId: open.driveId }), (e: unknown) => (e as { code?: string }).code === 'EXAM_NOT_OVER');
  // Nothing submitted in the closed drive yet: allowed (not EXAM_NOT_OVER), simply nothing to queue.
  const r = await start({ driveId: closed.driveId });
  assert.equal(r.queued, 0);
  const runs = await sa.get(`/api/admin/ai-evaluations?driveId=${drive.driveId}`);
  assert.equal(runs.status, 200);
  assert.ok(runs.body.data.items.every((x: { drive: { id: string; displayName: string } | null }) => x.drive?.id === drive.driveId));
  assert.match(runs.body.data.items[0].drive.displayName, /· Round 1 · AIC1 · Nov 2026$/);
});

test('AI run skips MCQ questions', async () => {
  const role = await prisma.jobRole.create({ data: { name: `AI MCQ Role ${RUN}` } });
  const d = await createDrive(role.id, { isOpen: false, college: 'AIC3', batch: 'Nov 2026' });
  const w = await prisma.question.create({ data: { roundId: d.roundId, text: 'Explain caching.', normalizedTextHash: `aimw-${RUN}`, maxMarks: 10 } });
  const m = await prisma.question.create({ data: { roundId: d.roundId, type: 'MCQ', text: 'Pick 7.', normalizedTextHash: `aimm-${RUN}`, maxMarks: 2, options: ['4', '6', '7', '9'], correctOption: 2 } });
  const mcqAq = { questionId: m.id, typeSnapshot: 'MCQ' as const, textSnapshot: m.text, maxMarksSnapshot: 2, optionsSnapshot: ['7', '4', '6', '9'], correctSnapshot: 0, negativeMarksSnapshot: 0, autoMarks: 2, answer: { create: { text: '', wordCount: 0, selectedOption: 0 } } };
  const attempt = async (key: string, written: boolean) => {
    const c = await createCandidate({ candidateCode: `AI-${RUN}-${key}`, fullName: `Cand ${key} ${RUN}`, email: `${key}-${RUN}@ai.int.test`, jobRoleId: role.id, driveId: d.driveId, status: written ? 'SUBMITTED' : 'EVALUATED' });
    const at = new Date(Date.now() - 60_000);
    const a = await prisma.examAttempt.create({
      data: {
        candidateId: c.id, status: 'SUBMITTED', startedAt: new Date(at.getTime() - 30 * 60_000), endsAt: at, submittedAt: at, submitType: 'MANUAL',
        activeSessionId: crypto.randomUUID(), startIp: '198.51.100.30', userAgent: 'int-test', maxMarks: written ? 12 : 2, mcqMarks: 2, mcqMaxMarks: 2,
        questions: {
          create: [
            { ...mcqAq, order: 1 },
            ...(written ? [{ questionId: w.id, order: 2, textSnapshot: w.text, maxMarksSnapshot: 10, answer: { create: { text: 'answer-good', wordCount: 1 } } }] : []),
          ],
        },
      },
      include: { questions: { orderBy: { order: 'asc' } } },
    });
    if (!written) await prisma.attemptEvaluation.create({ data: { attemptId: a.id, status: 'SUBMITTED', submittedAt: at } });
    return a;
  };
  const mixed = await attempt('aimix', true);
  await attempt('aionly', false);

  const before = enqueued.length;
  const r = await start({ driveId: d.driveId });
  assert.equal(r.queued, 1, 'only the written question is queued; the MCQ-only attempt queues nothing');
  const scores = await prisma.aiQuestionScore.findMany({ where: { attemptQuestion: { attempt: { candidate: { driveId: d.driveId } } } }, select: { attemptQuestionId: true } });
  assert.deepEqual(scores.map((s) => s.attemptQuestionId), [mixed.questions[1]!.id]);
  for (const id of enqueued.slice(before)) await ai.processScore(id, { finalAttempt: true });

  const view = await sa.get(`/api/admin/submissions/${mixed.id}`);
  assert.equal(view.body.data.ai.state, 'DONE', 'the roll-up ignores the MCQ');
  assert.equal(view.body.data.questions[0].ai, null);

  // Bulk accept marks the written question from AI; the total adds the MCQ subtotal.
  const acc = await sa.post('/api/admin/submissions/ai/accept').send({ driveId: d.driveId });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal(acc.body.data.accepted, 1);
  const done = await prisma.examAttempt.findUniqueOrThrow({ where: { id: mixed.id } });
  assert.deepEqual([done.totalMarks?.toNumber(), done.maxMarks.toNumber()], [11, 12]);
  assert.equal(await prisma.questionEvaluation.count({ where: { attemptQuestionId: mixed.questions[0]!.id } }), 0, 'no evaluator mark on the MCQ');
});
