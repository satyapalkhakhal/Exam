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
import { createCandidate } from './helpers.js';
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
  roleId = (await prisma.jobRole.create({ data: { name: `AI Role ${RUN}`, examSetting: { create: { isOpen: true } } } })).id;
  questionId = (await prisma.question.create({ data: { jobRoleId: roleId, text: 'Explain idempotency.', normalizedTextHash: `ai-${RUN}`, maxMarks: 10, evaluatorGuidance: 'Mentions retries' } })).id;
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

test('exam-over gate: an open exam refuses a role run; closing it allows one', async () => {
  await assert.rejects(() => start({ jobRoleId: roleId }), (e: unknown) => (e as { code?: string }).code === 'EXAM_NOT_OVER');
  await prisma.examSetting.update({ where: { jobRoleId: roleId }, data: { isOpen: false } });
  const r = await start({ jobRoleId: roleId });
  assert.equal(r.queued, 2);
  assert.equal(r.alreadyScored, 0);
});

test('processing the queued scores stores them, settles the run and exposes AI on the marking view', async () => {
  for (const id of enqueued) await ai.processScore(id, { finalAttempt: true });
  const [run] = await ai.list(roleId);
  assert.equal(run!.status, 'DONE');
  assert.equal(run!.done, 2);
  assert.equal(run!.inputTokens, 100);

  const view = await sa.get(`/api/admin/submissions/${cands.good!.attemptId}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.data.questions[0].ai.marks, 9);
  assert.equal(view.body.data.ai.state, 'DONE');

  const again = await start({ jobRoleId: roleId });
  assert.deepEqual({ queued: again.queued, alreadyScored: again.alreadyScored, run: again.run }, { queued: 0, alreadyScored: 2, run: null });
});

test('bulk accept: the clean script is accepted, the LOW-confidence one is skipped; leaderboard ranks by composite', async () => {
  const res = await sa.post('/api/admin/submissions/ai/accept').send({ jobRoleId: roleId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.accepted, 1);
  assert.deepEqual(res.body.data.skipped.map((s: { reason: string }) => s.reason), ['LOW_CONFIDENCE']);

  const accepted = await prisma.examAttempt.findUniqueOrThrow({ where: { id: cands.good!.attemptId }, include: { questions: { include: { evaluation: true } } } });
  assert.equal(Number(accepted.totalMarks), 9);
  assert.ok(accepted.questions[0]!.evaluation?.aiScoreId);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: cands.good!.candidateId } })).status, 'EVALUATED');

  const board = await sa.get(`/api/admin/leaderboard?jobRoleId=${roleId}&sort=composite`);
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
