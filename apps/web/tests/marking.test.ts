import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSubmitEvaluation, shouldSeedDrafts, sumMarks, validateMarksClient } from '../src/lib/marking.js';

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
