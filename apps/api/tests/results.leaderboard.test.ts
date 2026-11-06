// Leaderboard AI columns and composite (docs/ai-evaluation.md §7, §10): AI %
// needs every question scored; the composite uses the human % once the
// evaluation is submitted (else the AI %, flagged provisional); sort by human /
// composite / AI with nulls last and ties by earlier submit; weights apply.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMPOSITE_WEIGHTS, compositeScore, type CompositeWeights } from '@exam/shared';
import { createResultsService, scoreRow } from '../src/modules/results/results.service.js';
import type { ResultsRepository, ScoredAttempt } from '../src/modules/results/results.repository.js';

interface Spec {
  code: string;
  submittedAt: string;
  human: { total: number; marks: (number | null)[] } | null;
  ai: (number | null)[];
  x?: number | null;
  xii?: number | null;
  cpi?: number | null;
}

const MAX = 10;

function row(s: Spec): ScoredAttempt {
  const evaluated = s.human !== null;
  const total = s.human?.total ?? null;
  return {
    id: `att-${s.code}`,
    status: 'SUBMITTED',
    startedAt: new Date('2026-11-01T09:00:00Z'),
    submittedAt: new Date(s.submittedAt),
    submitType: 'MANUAL',
    totalMarks: total,
    maxMarks: MAX * s.ai.length,
    percentage: total === null ? null : (total / (MAX * s.ai.length)) * 100,
    candidate: {
      id: `cand-${s.code}`, candidateCode: s.code, fullName: 'N', email: 'n@example.com', mobile: null, rollNumber: null,
      xPercentage: s.x ?? null, xiiPercentage: s.xii ?? null, majorCpi: s.cpi ?? null, programme: null, discipline: null,
      status: evaluated ? 'EVALUATED' : 'SUBMITTED', result: null, jobRoleId: 'role', jobRole: { name: 'R' },
    },
    evaluation: { status: evaluated ? 'SUBMITTED' : 'DRAFT' },
    questions: s.ai.map((a, i) => ({
      order: i + 1,
      maxMarksSnapshot: MAX,
      evaluation: evaluated ? { marks: s.human!.marks[i] ?? null, comment: null } : null,
      aiScores: a === null ? [] : [{ marks: a }],
    })),
  } as unknown as ScoredAttempt;
}

function build(specs: Spec[], weights?: CompositeWeights) {
  const rows = specs.map(row);
  const calls: boolean[] = [];
  const repo = {
    leaderboard: async (_id: string, withAiOnly: boolean) => {
      calls.push(withAiOnly);
      return withAiOnly ? rows : rows.filter((r) => r.evaluation?.status === 'SUBMITTED');
    },
    weightsFor: async () => (weights ? new Map([['role', weights]]) : new Map()),
  } as unknown as ResultsRepository;
  const service = createResultsService({
    repo,
    getFlagsBatch: async () => new Map(),
    emailReady: async () => true,
    sendEmails: async () => ({ batchId: 'b', queued: 0, skipped: [] }),
  });
  return { service, calls };
}

// A: human 90%, AI 70% ; B: human 60%, AI 95% ; C: not evaluated, AI 80% ; D: not evaluated, AI incomplete
const SPECS: Spec[] = [
  { code: 'A', submittedAt: '2026-11-01T10:00:00Z', human: { total: 18, marks: [9, 9] }, ai: [7, 7], x: 80, xii: 80, cpi: 8 },
  { code: 'B', submittedAt: '2026-11-01T10:05:00Z', human: { total: 12, marks: [6, 6] }, ai: [9.5, 9.5], x: 100, xii: 100, cpi: 10 },
  { code: 'C', submittedAt: '2026-11-01T10:10:00Z', human: null, ai: [8, 8], x: 90, xii: null, cpi: null },
  { code: 'D', submittedAt: '2026-11-01T10:15:00Z', human: null, ai: [8, null] },
];

const order = (items: { candidateCode: string }[]) => items.map((i) => i.candidateCode).join('');

test('compositeScore: weights, re-spread of missing components, null without an exam %', () => {
  const w = DEFAULT_COMPOSITE_WEIGHTS;
  assert.equal(compositeScore({ examPercentage: 90, xPercentage: 80, xiiPercentage: 80, majorCpi: 8 }, w), 90 * 0.7 + 8 + 8 + 8);
  assert.equal(compositeScore({ examPercentage: 80, xPercentage: 90, xiiPercentage: null, majorCpi: null }, w), (80 * 70 + 90 * 10) / 80);
  assert.equal(compositeScore({ examPercentage: null, xPercentage: 90, xiiPercentage: 90, majorCpi: 9 }, w), null);
  assert.equal(compositeScore({ examPercentage: 50, xPercentage: 100, xiiPercentage: 100, majorCpi: 10 }, { exam: 100, x: 0, xii: 0, cpi: 0 }), 50);
});

test('sort=human (default) lists only human-evaluated rows, in the repository order, with AI columns filled', async () => {
  const { service, calls } = build(SPECS);
  const { items } = await service.leaderboard('role');
  assert.deepEqual(calls, [false]);
  assert.equal(order(items), 'AB');
  assert.deepEqual(items[0]!.questionMarks, [
    { order: 1, marks: 9, aiMarks: 7, maxMarks: 10 },
    { order: 2, marks: 9, aiMarks: 7, maxMarks: 10 },
  ]);
  assert.equal(items[0]!.aiPercentage, 70);
  assert.equal(items[0]!.compositeScore, 90 * 0.7 + 24);
  assert.equal(items[0]!.compositeProvisional, false);
});

test('sort=ai ranks by AI %, includes AI-only rows, nulls last', async () => {
  const { service, calls } = build(SPECS);
  const { items } = await service.leaderboard('role', 'ai');
  assert.deepEqual(calls, [true]);
  assert.equal(order(items), 'BCAD');
  assert.deepEqual(items.map((i) => i.rank), [1, 2, 3, 4]);
  assert.equal(items.find((i) => i.candidateCode === 'D')!.aiPercentage, null);
});

test('sort=composite: human % when submitted, AI % (provisional) otherwise; academics re-spread when missing', async () => {
  const { service } = build(SPECS);
  const { items } = await service.leaderboard('role', 'composite');
  const by = Object.fromEntries(items.map((i) => [i.candidateCode, i]));
  assert.equal(by.A!.compositeScore, 90 * 0.7 + 8 + 8 + 8);
  assert.equal(by.B!.compositeScore, 60 * 0.7 + 10 + 10 + 10);
  assert.equal(by.C!.compositeScore, Math.round(((80 * 70 + 90 * 10) / 80) * 100) / 100);
  assert.equal(by.C!.compositeProvisional, true);
  assert.equal(by.A!.compositeProvisional, false);
  assert.equal(by.D!.compositeScore, null);
  assert.equal(by.D!.compositeProvisional, false);
  assert.equal(order(items), 'ACBD');
  assert.deepEqual(by.C!.questionMarks.map((q) => q.marks), [null, null], 'no human marks before the evaluation is submitted');
});

test("the role's own weights drive the composite, so a change applies on the next read", async () => {
  const { service } = build(SPECS, { exam: 100, x: 0, xii: 0, cpi: 0 });
  const { items } = await service.leaderboard('role', 'composite');
  assert.equal(order(items), 'ACBD');
  assert.equal(items.find((i) => i.candidateCode === 'B')!.compositeScore, 60);
  const academic = build(SPECS, { exam: 10, x: 30, xii: 30, cpi: 30 });
  assert.equal(order((await academic.service.leaderboard('role', 'composite')).items), 'BCAD');
});

test('equal scores tie-break by earlier submission', async () => {
  const tie: Spec[] = [
    { code: 'LATE', submittedAt: '2026-11-01T11:00:00Z', human: null, ai: [8, 8] },
    { code: 'EARLY', submittedAt: '2026-11-01T10:00:00Z', human: null, ai: [8, 8] },
  ];
  const { items } = await build(tie).service.leaderboard('role', 'ai');
  assert.deepEqual(items.map((i) => i.candidateCode), ['EARLY', 'LATE']);
});

test('scoreRow: AI % only when every question has a DONE AI score', () => {
  const w = DEFAULT_COMPOSITE_WEIGHTS;
  assert.equal(scoreRow(row(SPECS[3]!), w).aiPercentage, null);
  assert.equal(scoreRow(row(SPECS[2]!), w).aiPercentage, 80);
});

test('results export: AI marks per question, AI %, composite, basis and the weights used', async () => {
  const rows = SPECS.map(row);
  const repo = {
    roles: async () => [{ id: 'role', name: 'Role', refApplicantCount: 0 }],
    submittedAttempts: async () => rows,
    weightsFor: async () => new Map([['role', { exam: 60, x: 20, xii: 10, cpi: 10 }]]),
  } as unknown as ResultsRepository;
  const service = createResultsService({ repo, getFlagsBatch: async () => new Map(), emailReady: async () => true, sendEmails: async () => ({ batchId: 'b', queued: 0, skipped: [] }) });
  const { sheets } = await service.resultsExport(undefined);
  const sheet = sheets[0]!;
  const headers = sheet.columns.map((c) => c.header);
  for (const h of ['Q1 AI marks', 'Q2 AI marks', 'AI %', 'Composite', 'Composite basis', 'Weights (exam/X/XII/CPI)']) assert.ok(headers.includes(h), h);
  const cell = (code: string, header: string) => sheet.rows[SPECS.findIndex((s) => s.code === code)]![headers.indexOf(header)];
  assert.equal(cell('A', 'Q1 AI marks'), 7);
  assert.equal(cell('A', 'AI %'), 70);
  assert.equal(cell('A', 'Composite basis'), 'Human');
  assert.equal(cell('C', 'Composite basis'), 'AI (provisional)');
  assert.equal(cell('D', 'Composite'), null);
  assert.equal(cell('A', 'Weights (exam/X/XII/CPI)'), '60/20/10/10');
});
