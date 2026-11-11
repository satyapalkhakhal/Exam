import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiQuestionScoreDto } from '@exam/shared';
import {
  aiErrorMessage, aiStateBadge, fillDraftsFromAi, hasRunningRun, isProvisional, parseWeights, runPercent,
  runProgressLabel, runsRefetchInterval, summariseSkips, weightsError, weightsSum,
} from '../src/lib/aiEvaluation.js';

const score = (over: Partial<AiQuestionScoreDto>): AiQuestionScoreDto => ({
  id: 's', status: 'DONE', marks: 6, maxMarks: 10, rationale: null, strengths: [], improvements: [], confidence: 'HIGH',
  concerns: [], model: 'm', error: null, completedAt: null, ...over,
});

test('aiStateBadge maps roll-up to label and variant', () => {
  assert.deepEqual(aiStateBadge({ state: 'NONE', totalMarks: null, percentage: null, needsReview: false }), { label: 'Not run', variant: 'outline' });
  assert.equal(aiStateBadge({ state: 'PARTIAL', totalMarks: null, percentage: null, needsReview: false }).label, 'Partial');
  assert.equal(aiStateBadge({ state: 'DONE', totalMarks: 5, percentage: 50, needsReview: false }).label, 'Done');
  assert.equal(aiStateBadge({ state: 'DONE', totalMarks: 5, percentage: 50, needsReview: true }).label, 'Needs review');
});

test('fillDraftsFromAi fills only DONE scores and keeps comments', () => {
  const drafts = { a: { marks: '', comment: 'keep' }, b: { marks: '3', comment: '' }, c: { marks: '2', comment: 'x' } };
  const qs = [
    { attemptQuestionId: 'a', ai: score({ marks: 7.5 }) },
    { attemptQuestionId: 'b', ai: score({ status: 'FAILED', marks: null }) },
    { attemptQuestionId: 'c', ai: null },
    { attemptQuestionId: 'd', ai: score({ marks: 0 }) },
  ];
  const all = fillDraftsFromAi(drafts, qs);
  assert.deepEqual(all.a, { marks: '7.5', comment: 'keep' });
  assert.deepEqual(all.b, drafts.b);
  assert.deepEqual(all.c, drafts.c);
  assert.deepEqual(all.d, { marks: '0', comment: '' });
  const one = fillDraftsFromAi(drafts, qs, 'd');
  assert.equal(one.a?.marks, '');
  assert.equal(one.d?.marks, '0');
});

test('summariseSkips groups reasons, most frequent first, in plain words', () => {
  const s = summariseSkips([{ reason: 'LOCKED' }, { reason: 'AI_CONCERNS' }, { reason: 'AI_CONCERNS' }]);
  assert.deepEqual(s.map((x) => [x.reason, x.count]), [['AI_CONCERNS', 2], ['LOCKED', 1]]);
  assert.equal(s[0]?.label, 'AI raised concerns');
});

test('aiErrorMessage handles the AI codes only', () => {
  assert.equal(aiErrorMessage('AI_NOT_CONFIGURED')?.linkToIntegrations, true);
  assert.equal(aiErrorMessage('EXAM_NOT_OVER')?.text, 'This drive is still open or someone is still taking it.');
  assert.equal(aiErrorMessage('INTERNAL'), null);
});

test('weights sum and validation', () => {
  assert.equal(weightsSum({ exam: 70, x: 10, xii: 10, cpi: 10 }), 100);
  assert.equal(weightsError({ exam: 70, x: 10, xii: 10, cpi: 10 }), null);
  assert.match(weightsError({ exam: 70, x: 10, xii: 10, cpi: 5 }) ?? '', /add up to 95/);
  assert.match(weightsError({ exam: 0, x: 40, xii: 30, cpi: 30 }) ?? '', /exam weight/);
  assert.ok(weightsError({ exam: Number.NaN, x: 10, xii: 10, cpi: 10 }));
  assert.ok(weightsError({ exam: 70.5, x: 9.5, xii: 10, cpi: 10 }));
  assert.equal(weightsSum({ exam: Number.NaN, x: 10, xii: 10, cpi: 10 }), 30);
  assert.deepEqual(parseWeights({ exam: 1, x: 2, xii: 3, cpi: 4 }), { exam: 1, x: 2, xii: 3, cpi: 4 });
});

test('run helpers', () => {
  const run = (status: 'RUNNING' | 'DONE', done: number, failed: number, total: number) =>
    ({ status, done, failed, total }) as Parameters<typeof hasRunningRun>[0] extends (infer R)[] | undefined ? R : never;
  assert.equal(hasRunningRun([run('DONE', 1, 0, 1)]), false);
  assert.equal(hasRunningRun([run('RUNNING', 0, 0, 1)]), true);
  assert.equal(runsRefetchInterval([run('RUNNING', 0, 0, 1)]), 3000);
  assert.equal(runsRefetchInterval(undefined), false);
  assert.equal(runProgressLabel({ done: 3, failed: 1, total: 10 }), '3 of 10 done, 1 failed');
  assert.equal(runPercent({ done: 3, failed: 1, total: 8 }), 50);
  assert.equal(runPercent({ done: 0, failed: 0, total: 0 }), 0);
});

test('isProvisional needs a composite', () => {
  assert.equal(isProvisional({ compositeScore: null, compositeProvisional: true }), false);
  assert.equal(isProvisional({ compositeScore: 60, compositeProvisional: true }), true);
});

test('selection from two drives is not AI-runnable', async () => {
  const { selectionSpansDrives } = await import('../src/lib/aiEvaluation.js');
  assert.equal(selectionSpansDrives(['Quant · Round 1 · IITG · Nov 2026', 'Quant · Round 1 · NITT · Nov 2026']), true);
  assert.equal(selectionSpansDrives(['Quant · Round 1 · IITG · Nov 2026', 'Quant · Round 1 · IITG · Nov 2026']), false);
  assert.equal(selectionSpansDrives([undefined, 'A']), false, 'unknown drive names do not count');
  assert.equal(selectionSpansDrives([]), false);
});

test('aiErrorMessage explains MIXED_DRIVES and a drive still open', () => {
  assert.equal(aiErrorMessage('MIXED_DRIVES')?.text, 'Select submissions from one drive.');
  assert.match(aiErrorMessage('EXAM_NOT_OVER')!.text, /drive/);
});
