// AI evaluation runs with an in-memory repository and a fake grader: the gate
// (AI configured, exam over), run creation, the queue job body (DONE, clamped
// marks, malformed output, FAILED on the last attempt), run completion and
// cancel. Nothing here calls OpenAI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiGradeOutput } from '@exam/shared';
import {
  createAiEvaluationService,
  isExamOver,
  type AiEvaluationDeps,
  type AiEvaluationRepository,
  type RunRow,
  type ScoreForGrading,
} from '../src/modules/aiEvaluation/aiEvaluation.service.js';
import { normaliseMarks, type AiGrader, type GradeRequest } from '../src/modules/aiEvaluation/aiEvaluation.grader.js';
import { AiOutputError, AiProviderError, backoffDelayMs, safeErrorText } from '../src/modules/aiEvaluation/aiEvaluation.errors.js';
import { AI_DEFAULTS, mergeAi, type AiConfig } from '../src/modules/aiEvaluation/aiEvaluation.config.js';
import { AppError } from '../src/shared/errors.js';

const ACTOR = { id: '00000000-0000-4000-8000-0000000000aa', ip: '127.0.0.1' };
const ROLE = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-11-06T10:00:00Z');
const READY: AiConfig = { ...AI_DEFAULTS, enabled: true, apiKey: 'sk-test', model: 'gpt-test' };

interface Score extends ScoreForGrading {
  runId: string;
  marks?: number;
  concerns?: string[];
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function fakeRepo(seed: { questions?: { id: string; max: number; hasDone?: boolean; hasQueued?: boolean }[]; roleState?: { inProgress: number; isOpen: boolean; windowEnd: Date | null } | null } = {}) {
  const runs = new Map<string, RunRow>();
  const scores = new Map<string, Score>();
  let n = 0;
  const settle = (runId: string) => {
    const r = runs.get(runId)!;
    if (r.done + r.failed >= r.total && r.status === 'RUNNING') {
      r.status = 'DONE';
      r.finishedAt = NOW;
    }
  };
  const repo: AiEvaluationRepository = {
    async roleExamState() {
      return seed.roleState === undefined ? { inProgress: 0, isOpen: false, windowEnd: null } : seed.roleState;
    },
    async gradableQuestions() {
      return (seed.questions ?? []).map((q) => ({ attemptQuestionId: q.id, maxMarks: q.max, hasDone: q.hasDone ?? false, hasQueued: q.hasQueued ?? false }));
    },
    async createRun(d) {
      const id = `run-${++n}`;
      const run: RunRow = {
        id, jobRole: d.jobRoleId ? { id: d.jobRoleId, name: 'Role' } : null, model: d.model, promptVersion: d.promptVersion, status: 'RUNNING',
        total: d.items.length, done: 0, failed: 0, inputTokens: 0, outputTokens: 0, createdBy: { name: 'Admin' }, createdAt: NOW, finishedAt: null,
      };
      runs.set(id, run);
      const scoreIds = d.items.map((i) => {
        const sid = `score-${++n}`;
        scores.set(sid, { id: sid, runId: id, status: 'QUEUED', runStatus: 'RUNNING', maxMarks: i.maxMarks, questionText: `Q ${i.attemptQuestionId}`, guidance: 'rubric', answerText: 'my answer', wordCount: 2 });
        return sid;
      });
      return { run, scoreIds };
    },
    async listRuns() {
      return [...runs.values()];
    },
    async loadForGrading(id) {
      const s = scores.get(id);
      return s ? { ...s, runStatus: runs.get(s.runId)!.status } : null;
    },
    async completeScore(id, r) {
      const s = scores.get(id)!;
      if (s.status !== 'QUEUED') return false;
      Object.assign(s, { status: 'DONE', marks: r.marks, concerns: r.concerns, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
      const run = runs.get(s.runId)!;
      run.done++;
      run.inputTokens += r.inputTokens;
      run.outputTokens += r.outputTokens;
      settle(run.id);
      return true;
    },
    async failScore(id, error) {
      const s = scores.get(id)!;
      if (s.status !== 'QUEUED') return false;
      Object.assign(s, { status: 'FAILED', error });
      runs.get(s.runId)!.failed++;
      settle(s.runId);
      return true;
    },
    async cancelRun(runId) {
      const run = runs.get(runId);
      if (!run) return null;
      if (run.status !== 'RUNNING') return { notRunning: true };
      const queued = [...scores.values()].filter((s) => s.runId === runId && s.status === 'QUEUED');
      for (const s of queued) Object.assign(s, { status: 'FAILED', error: 'cancelled' });
      run.status = 'CANCELLED';
      run.failed += queued.length;
      return { run, cancelledScoreIds: queued.map((s) => s.id) };
    },
  };
  return { repo, runs, scores };
}

const goodOutput: AiGradeOutput = { marks: 7, rationale: 'ok', strengths: ['a'], improvements: ['b'], confidence: 'HIGH', concerns: [] };

function setup(opts: { cfg?: AiConfig; output?: unknown | (() => unknown); seed?: Parameters<typeof fakeRepo>[0]; graderThrows?: () => Error | null } = {}) {
  const fake = fakeRepo(opts.seed);
  const requests: GradeRequest[] = [];
  const enqueued: string[][] = [];
  const removed: string[][] = [];
  const audits: { action: string; metadata?: Record<string, unknown> }[] = [];
  const grader: AiGrader = {
    async grade(req) {
      requests.push(req);
      const err = opts.graderThrows?.();
      if (err) throw err;
      const output = typeof opts.output === 'function' ? (opts.output as () => unknown)() : (opts.output ?? goodOutput);
      return { output: output as AiGradeOutput, inputTokens: 100, outputTokens: 20, model: 'gpt-test-2026' };
    },
  };
  const deps: AiEvaluationDeps = {
    repo: fake.repo,
    getConfig: async () => opts.cfg ?? READY,
    grader,
    enqueue: async (ids) => void enqueued.push(ids),
    removeJobs: async (ids) => void removed.push(ids),
    audit: async (e) => void audits.push(e),
    now: () => NOW,
  };
  return { service: createAiEvaluationService(deps), ...fake, requests, enqueued, removed, audits };
}

const qs = (...max: number[]) => max.map((m, i) => ({ id: `aq-${i + 1}`, max: m }));
const expectCode = (code: string, status: number) => (e: unknown) => e instanceof AppError && e.code === code && e.statusCode === status;

// ---- gate ------------------------------------------------------------------------

test('start: AI disabled, key missing or model empty -> 409 AI_NOT_CONFIGURED', async () => {
  for (const cfg of [{ ...READY, enabled: false }, { ...READY, apiKey: '' }, { ...READY, model: ' ' }]) {
    const { service, enqueued } = setup({ cfg, seed: { questions: qs(10) } });
    await assert.rejects(() => service.start({ attemptIds: ['a'] }, ACTOR), expectCode('AI_NOT_CONFIGURED', 409));
    assert.equal(enqueued.length, 0);
  }
});

test('isExamOver: needs nobody in progress AND (closed OR window ended)', () => {
  const past = new Date(NOW.getTime() - 1000);
  const future = new Date(NOW.getTime() + 1000);
  assert.equal(isExamOver({ inProgress: 0, isOpen: false, windowEnd: null }, NOW), true);
  assert.equal(isExamOver({ inProgress: 0, isOpen: true, windowEnd: past }, NOW), true);
  assert.equal(isExamOver({ inProgress: 0, isOpen: true, windowEnd: future }, NOW), false);
  assert.equal(isExamOver({ inProgress: 0, isOpen: true, windowEnd: null }, NOW), false);
  assert.equal(isExamOver({ inProgress: 1, isOpen: false, windowEnd: past }, NOW), false);
});

test('start by role: someone still in progress, or still open -> 409 EXAM_NOT_OVER', async () => {
  for (const roleState of [
    { inProgress: 2, isOpen: false, windowEnd: null },
    { inProgress: 0, isOpen: true, windowEnd: new Date(NOW.getTime() + 60_000) },
  ]) {
    const { service, enqueued } = setup({ seed: { questions: qs(10), roleState } });
    await assert.rejects(() => service.start({ jobRoleId: ROLE }, ACTOR), expectCode('EXAM_NOT_OVER', 409));
    assert.equal(enqueued.length, 0);
  }
});

test('start by role: unknown role -> 404; attempt ids skip the exam-over gate', async () => {
  const unknown = setup({ seed: { roleState: null } });
  await assert.rejects(() => unknown.service.start({ jobRoleId: ROLE }, ACTOR), expectCode('NOT_FOUND', 404));
  const open = setup({ seed: { questions: qs(10), roleState: { inProgress: 5, isOpen: true, windowEnd: null } } });
  const r = await open.service.start({ attemptIds: ['a'] }, ACTOR);
  assert.equal(r.queued, 1);
});

// ---- run creation -----------------------------------------------------------------

test('start: queues one job per question, records the run and audits counts only', async () => {
  const { service, enqueued, audits, runs } = setup({ seed: { questions: qs(10, 5, 5) } });
  const r = await service.start({ jobRoleId: ROLE }, ACTOR);
  assert.equal(r.queued, 3);
  assert.equal(r.alreadyScored, 0);
  assert.equal(r.run?.total, 3);
  assert.equal(r.run?.status, 'RUNNING');
  assert.equal(r.run?.model, 'gpt-test');
  assert.equal(enqueued[0]?.length, 3);
  assert.equal(runs.size, 1);
  assert.equal(audits[0]?.action, 'AI_EVALUATION_STARTED');
  assert.ok(!JSON.stringify(audits).includes('sk-test'));
});

test('start: already DONE or already queued questions are skipped unless force', async () => {
  const seed = { questions: [{ id: 'q1', max: 10, hasDone: true }, { id: 'q2', max: 10, hasQueued: true }, { id: 'q3', max: 10 }] };
  const a = await setup({ seed }).service.start({ attemptIds: ['a'] }, ACTOR);
  assert.equal(a.queued, 1);
  assert.equal(a.alreadyScored, 2);
  const f = await setup({ seed }).service.start({ attemptIds: ['a'], force: true }, ACTOR);
  assert.equal(f.queued, 2, 'force regrades DONE but never double-queues one in flight');

  const none = setup({ seed: { questions: [{ id: 'q1', max: 10, hasDone: true }] } });
  assert.deepEqual(await none.service.start({ attemptIds: ['a'] }, ACTOR), { run: null, queued: 0, alreadyScored: 1 });
  assert.equal(none.enqueued.length, 0);
});

test('start: a queue failure cancels the run and rethrows', async () => {
  const t = setup({ seed: { questions: qs(10) } });
  const failing = createAiEvaluationService({
    repo: t.repo,
    getConfig: async () => READY,
    grader: { grade: async () => assert.fail('no call') },
    enqueue: async () => {
      throw new Error('redis down');
    },
    removeJobs: async () => {},
    audit: async () => {},
    now: () => NOW,
  });
  await assert.rejects(() => failing.start({ attemptIds: ['a'] }, ACTOR), /redis down/);
  assert.equal([...t.runs.values()][0]?.status, 'CANCELLED');
});

// ---- queue job body ---------------------------------------------------------------

async function startOne(opts: Parameters<typeof setup>[0] = {}, max = 10) {
  const t = setup({ ...opts, seed: { questions: qs(max) } });
  await t.service.start({ attemptIds: ['a'] }, ACTOR);
  const scoreId = t.enqueued[0]![0]!;
  return { ...t, scoreId, run: () => [...t.runs.values()][0]! };
}

test('process: stores the score, bumps the run counters and tokens, and finishes the run', async () => {
  const t = await startOne();
  await t.service.processScore(t.scoreId, { finalAttempt: false });
  const s = t.scores.get(t.scoreId)!;
  assert.equal(s.status, 'DONE');
  assert.equal(s.marks, 7);
  assert.equal(t.run().done, 1);
  assert.equal(t.run().inputTokens, 100);
  assert.equal(t.run().outputTokens, 20);
  assert.equal(t.run().status, 'DONE');
  assert.ok(t.run().finishedAt);
});

test('process: the grader receives the prompt built from the question and rubric, with the configured model', async () => {
  const t = await startOne({ cfg: { ...READY, gradingInstructions: 'Be strict.' } });
  await t.service.processScore(t.scoreId, { finalAttempt: false });
  const req = t.requests[0]!;
  assert.equal(req.model, 'gpt-test');
  assert.ok(req.user.includes('my answer') && req.user.includes('rubric') && req.user.includes('MAXIMUM MARKS: 10'));
  assert.ok(req.system.includes('Be strict.'));
});

test('normaliseMarks clamps to 0…max in 0.5 steps and rejects non-numbers', () => {
  assert.equal(normaliseMarks(7.3, 10), 7.5);
  assert.equal(normaliseMarks(7.2, 10), 7);
  assert.equal(normaliseMarks(7.25, 10), 7.5);
  assert.equal(normaliseMarks(-3, 10), 0);
  assert.equal(normaliseMarks(99, 10), 10);
  assert.equal(normaliseMarks(10, 7.3), 7, 'a max that is not a half step is rounded down');
  assert.throws(() => normaliseMarks(Number.NaN, 10), AiOutputError);
  assert.throws(() => normaliseMarks(Number.POSITIVE_INFINITY, 10), AiOutputError);
});

test('process: out-of-range marks are clamped before they are stored', async () => {
  const t = await startOne({ output: { ...goodOutput, marks: 42.3 } });
  await t.service.processScore(t.scoreId, { finalAttempt: false });
  assert.equal(t.scores.get(t.scoreId)!.marks, 10);
});

test('process: a malformed reply throws (job retries) and leaves the score QUEUED until the last attempt', async () => {
  const t = await startOne({ output: { marks: 'lots', rationale: 1 } });
  await assert.rejects(() => t.service.processScore(t.scoreId, { finalAttempt: false }), AiOutputError);
  assert.equal(t.scores.get(t.scoreId)!.status, 'QUEUED');
  assert.equal(t.run().failed, 0);
  await assert.rejects(() => t.service.processScore(t.scoreId, { finalAttempt: true }), AiOutputError);
  assert.equal(t.scores.get(t.scoreId)!.status, 'FAILED');
  assert.equal(t.scores.get(t.scoreId)!.error, 'The model returned an invalid response');
  assert.equal(t.run().failed, 1);
  assert.equal(t.run().status, 'DONE', 'done + failed = total settles the run');
});

test('process: an unknown concern value is invalid output; known ones are stored', async () => {
  const bad = await startOne({ output: { ...goodOutput, concerns: ['VIBES'] } });
  await assert.rejects(() => bad.service.processScore(bad.scoreId, { finalAttempt: false }), AiOutputError);
  const good = await startOne({ output: { ...goodOutput, concerns: ['PROMPT_INJECTION'] } });
  await good.service.processScore(good.scoreId, { finalAttempt: false });
  assert.deepEqual(good.scores.get(good.scoreId)!.concerns, ['PROMPT_INJECTION']);
});

test('process: a provider error on the last attempt stores a safe reason (no provider text) and rethrows', async () => {
  const t = await startOne({ graderThrows: () => new AiProviderError('OpenAI rate limit or quota reached (429)', 429, 4_000) });
  await assert.rejects(() => t.service.processScore(t.scoreId, { finalAttempt: true }), AiProviderError);
  const s = t.scores.get(t.scoreId)!;
  assert.equal(s.status, 'FAILED');
  assert.equal(s.error, 'OpenAI rate limit or quota reached (429)');
});

test('process: an unexpected error is stored as a generic reason, never its message', async () => {
  const t = await startOne({ graderThrows: () => new Error('Incorrect API key provided: sk-live-abcdef') });
  await assert.rejects(() => t.service.processScore(t.scoreId, { finalAttempt: true }));
  assert.equal(t.scores.get(t.scoreId)!.error, 'Grading failed');
  assert.equal(safeErrorText(new Error('secret')), 'Grading failed');
});

test('process: a stale job (already DONE, unknown id, or cancelled run) is a no-op', async () => {
  const t = await startOne();
  await t.service.processScore(t.scoreId, { finalAttempt: false });
  await t.service.processScore(t.scoreId, { finalAttempt: false });
  await t.service.processScore('missing', { finalAttempt: false });
  assert.equal(t.requests.length, 1);
  assert.equal(t.run().done, 1);
});

test('process: AI switched off after queueing fails the job instead of calling the model', async () => {
  const t = await startOne();
  const off = createAiEvaluationService({
    repo: t.repo,
    getConfig: async () => ({ ...READY, apiKey: '' }),
    grader: { grade: async () => assert.fail('must not call') },
    enqueue: async () => {},
    removeJobs: async () => {},
    audit: async () => {},
    now: () => NOW,
  });
  await assert.rejects(() => off.processScore(t.scoreId, { finalAttempt: true }), AiProviderError);
  assert.equal(t.scores.get(t.scoreId)!.status, 'FAILED');
});

// ---- cancel -----------------------------------------------------------------------

test('cancel: run CANCELLED, queued scores FAILED(cancelled), their jobs removed, audited', async () => {
  const t = setup({ seed: { questions: qs(10, 10, 10) } });
  await t.service.start({ attemptIds: ['a'] }, ACTOR);
  const [first, ...rest] = t.enqueued[0]!;
  await t.service.processScore(first!, { finalAttempt: false });
  const dto = await t.service.cancel('run-1', ACTOR);
  assert.equal(dto.status, 'CANCELLED');
  assert.equal(dto.done, 1);
  assert.equal(dto.failed, 2);
  assert.deepEqual(t.removed[0]?.sort(), [...rest].sort());
  for (const id of rest) {
    assert.equal(t.scores.get(id)!.status, 'FAILED');
    assert.equal(t.scores.get(id)!.error, 'cancelled');
  }
  assert.equal(t.scores.get(first!)!.status, 'DONE', 'finished scores are kept');
  assert.equal(t.audits.at(-1)?.action, 'AI_EVALUATION_CANCELLED');

  // a job that was already running when the cancel landed is ignored
  await t.service.processScore(rest[0]!, { finalAttempt: false });
  assert.equal(t.requests.length, 1);
});

test('cancel: unknown run -> 404; finished run -> 409', async () => {
  const t = await startOne();
  await assert.rejects(() => t.service.cancel('nope', ACTOR), expectCode('NOT_FOUND', 404));
  await t.service.processScore(t.scoreId, { finalAttempt: false });
  await assert.rejects(() => t.service.cancel('run-1', ACTOR), expectCode('CONFLICT', 409));
});

// ---- connection test, backoff, config ------------------------------------------------

test('testConnection: one tiny call with the saved key; no credentials -> AI_NOT_CONFIGURED; works while disabled', async () => {
  const t = setup({ cfg: { ...READY, enabled: false } });
  assert.deepEqual(await t.service.testConnection(), { model: 'gpt-test-2026' });
  assert.equal(t.requests.length, 1);
  const none = setup({ cfg: { ...READY, apiKey: '' } });
  await assert.rejects(() => none.service.testConnection(), expectCode('AI_NOT_CONFIGURED', 409));
});

test('backoffDelayMs: exponential, never sooner than a 429 retry-after, capped', () => {
  assert.equal(backoffDelayMs(1), 10_000);
  assert.equal(backoffDelayMs(2), 20_000);
  assert.equal(backoffDelayMs(3), 40_000);
  assert.equal(backoffDelayMs(1, new AiProviderError('x', 429, 45_000)), 45_000);
  assert.equal(backoffDelayMs(3, new AiProviderError('x', 429, 5_000)), 40_000);
  assert.equal(backoffDelayMs(1, new AiProviderError('x', 429, 99 * 60_000)), 5 * 60_000);
  assert.equal(backoffDelayMs(1, new Error('plain')), 10_000);
});

test('mergeAi fills defaults and repairs a bad concurrency', () => {
  assert.deepEqual(mergeAi({}), AI_DEFAULTS);
  assert.equal(mergeAi({ concurrency: 0 }).concurrency, 3);
  assert.equal(mergeAi({ concurrency: 2, model: 'm' }).model, 'm');
});
