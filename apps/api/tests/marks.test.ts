// Marks rules (design §8): 0…max in steps of 0.5, enforced server-side, and
// the percentage rounded to two places.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentageOf, validateMarks } from '../src/modules/evaluation/marks.js';
import { AppError } from '../src/shared/errors.js';

test('validateMarks accepts 0…max in steps of 0.5', () => {
  assert.doesNotThrow(() => validateMarks(7.5, 10));
  assert.doesNotThrow(() => validateMarks(0, 10));
  assert.doesNotThrow(() => validateMarks(10, 10));
});

test('validateMarks rejects above max, negative and non-0.5 steps as MARKS_OUT_OF_RANGE', () => {
  for (const m of [10.5, -1, 3.3, Number.NaN]) {
    assert.throws(
      () => validateMarks(m, 10, 'aq-1'),
      (e: unknown) => e instanceof AppError && e.code === 'MARKS_OUT_OF_RANGE' && e.statusCode === 400 &&
        (e.details as { attemptQuestionId: string }).attemptQuestionId === 'aq-1',
    );
  }
});

test('percentageOf rounds to two places', () => {
  assert.equal(percentageOf(37.5, 50), 75);
  assert.equal(percentageOf(1, 3), 33.33);
  assert.equal(percentageOf(0, 0), 0);
});
