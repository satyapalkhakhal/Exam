import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSubmitEvaluation, markingTotal, mcqCell, shouldSeedDrafts, sumMarks, validateMarksClient, writtenRows } from '../src/lib/marking.js';

test('sumMarks ignores unmarked items', () => {
  assert.equal(sumMarks([{ marks: 7.5 }, { marks: 10 }, { marks: null }]), 17.5);
  assert.equal(sumMarks([]), 0);
});

test('canSubmitEvaluation needs marks on every question', () => {
  assert.equal(canSubmitEvaluation([{ marks: 1 }, { marks: null }]), false);
  assert.equal(canSubmitEvaluation([{ marks: 0 }, { marks: 2 }]), true);
  assert.equal(canSubmitEvaluation([]), false);
});

test('validateMarksClient mirrors the server rules', () => {
  assert.equal(validateMarksClient(7.5, 10), null);
  assert.equal(validateMarksClient(0, 10), null);
  assert.equal(validateMarksClient(10, 10), null);
  assert.ok(validateMarksClient(10.5, 10));
  assert.ok(validateMarksClient(-1, 10));
  assert.ok(validateMarksClient(3.3, 10));
  assert.ok(validateMarksClient(Number.NaN, 10));
});

test('T17#3: drafts are never seeded from data cached before the lock settled', () => {
  const lockSettledAt = 1_000;
  assert.equal(shouldSeedDrafts({ seeded: false, lockSettledAt: null, dataUpdatedAt: 500, isFetching: false }), false, 'lock still pending');
  assert.equal(shouldSeedDrafts({ seeded: false, lockSettledAt, dataUpdatedAt: 500, isFetching: false }), false, 'stale cached copy');
  assert.equal(shouldSeedDrafts({ seeded: false, lockSettledAt, dataUpdatedAt: 500, isFetching: true }), false, 'refetch in flight');
  assert.equal(shouldSeedDrafts({ seeded: false, lockSettledAt, dataUpdatedAt: 1_200, isFetching: false }), true, 'fresh read after the lock');
  assert.equal(shouldSeedDrafts({ seeded: true, lockSettledAt, dataUpdatedAt: 1_200, isFetching: false }), false, 'only once');
});

test('draft completeness counts written questions only', () => {
  const questions = [
    { attemptQuestionId: 'm1', type: 'MCQ' as const, maxMarks: 2 },
    { attemptQuestionId: 'm2', type: 'MCQ' as const, maxMarks: 1 },
    { attemptQuestionId: 'w1', type: 'WRITTEN' as const, maxMarks: 5 },
  ];
  const rows = writtenRows(questions, { w1: { marks: '4', comment: '' } });
  assert.deepEqual(rows.map((r) => [r.q.attemptQuestionId, r.marks]), [['w1', 4]]);
  assert.equal(canSubmitEvaluation(rows), true, 'MCQs need no marks');
  assert.equal(canSubmitEvaluation(writtenRows(questions, {})), false);
  // Total = written + MCQ subtotal, over the full max, floored at 0.
  assert.deepEqual(markingTotal(rows, 5, 1.5, 3), { total: 5.5, max: 8 });
  assert.deepEqual(markingTotal(writtenRows(questions, { w1: { marks: '0', comment: '' } }), 5, -1, 3), { total: 0, max: 8 });
  assert.deepEqual(markingTotal(rows, 5, null, 0), { total: 4, max: 5 });
});

test('MCQ cell: marks / max, "-" when the test has no MCQs', () => {
  assert.equal(mcqCell({ mcqMarks: 1.5, mcqMaxMarks: 3 }), '1.5 / 3');
  assert.equal(mcqCell({ mcqMarks: -0.5, mcqMaxMarks: 3 }), '-0.5 / 3');
  assert.equal(mcqCell({ mcqMarks: null, mcqMaxMarks: 0 }), '-');
});
