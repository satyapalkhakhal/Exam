// MCQ scoring rule (spec 2026-11-10 MCQ questions): right = its marks, wrong = minus the
// round's negative marks, unanswered = 0; subtotal sums them (it may be negative).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcqSubtotal, scoreMcq } from '../src/modules/exam/mcqMarks.js';

test('scoreMcq: right, wrong with negative, unanswered', () => {
  assert.equal(scoreMcq({ maxMarks: 2, correct: 1, negative: 0.25 }, 1), 2);
  assert.equal(scoreMcq({ maxMarks: 2, correct: 1, negative: 0.25 }, 3), -0.25);
  assert.equal(scoreMcq({ maxMarks: 2, correct: 1, negative: 0 }, 0), 0);
  assert.equal(scoreMcq({ maxMarks: 2, correct: 1, negative: 0.5 }, null), 0);
});

test('mcqSubtotal sums marks and maxima, and counts correct / wrong / unanswered', () => {
  const r = mcqSubtotal([
    { maxMarks: 2, correct: 0, negative: 0.5, selected: 0 },
    { maxMarks: 1, correct: 2, negative: 0.5, selected: 1 },
    { maxMarks: 1, correct: 3, negative: 0.5, selected: null },
  ]);
  assert.deepEqual(r, { marks: [2, -0.5, 0], total: 1.5, max: 4, correct: 1, wrong: 1, unanswered: 1 });
});
