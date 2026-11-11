// Combined totals (spec 2026-11-10 MCQ questions): written marks plus the MCQ
// subtotal, over the full maximum, floored at 0 (negative marking can drive
// the MCQ part below zero, never the total).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combinedTotals } from '../src/modules/evaluation/marks.js';

test('total is floored at 0', () => {
  assert.deepEqual(combinedTotals(0, 5, -1.5, 3), { totalMarks: 0, maxMarks: 8, percentage: 0 });
  assert.deepEqual(combinedTotals(1, 5, -0.5, 3), { totalMarks: 0.5, maxMarks: 8, percentage: 6.25 });
});

test('combined percentage over full max', () => {
  assert.deepEqual(combinedTotals(4, 5, 2, 3), { totalMarks: 6, maxMarks: 8, percentage: 75 });
  // No MCQs: unchanged from written-only marking.
  assert.deepEqual(combinedTotals(7.5, 15, null, 0), { totalMarks: 7.5, maxMarks: 15, percentage: 50 });
  // Quarter deductions add up without float noise.
  assert.equal(combinedTotals(0.5, 5, 1.75, 3).totalMarks, 2.25);
});
