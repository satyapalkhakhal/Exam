// flagScore: the single review-flag number shown on lists. Blocked
// paste/copy/cut/drop, bulk inserts, IP changes and location flags each count;
// tab switching counts once, and only when it happened 3 or more times.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagBreakdown, flagScore } from '../src/modules/exam/flagScore.js';

const integrity = { pasteAttempts: 2, bulkInsert: 1, tabHidden: 2, blur: 7, ipChanges: 1 };
const location = [{ code: 'SHARED_IP' as const, ip: '203.0.113.1', count: 4 }];

test('tab switching below 3 and window blur do not count', () => {
  assert.equal(flagScore({ integrity, location }), 2 + 1 + 1 + 1);
});

test('tab switching 3+ times adds exactly one', () => {
  assert.equal(flagScore({ integrity: { ...integrity, tabHidden: 9 }, location }), 6);
});

test('the breakdown sums to the score and carries no location detail', () => {
  const b = flagBreakdown({ integrity: { ...integrity, tabHidden: 3 }, location });
  assert.deepEqual(b, { pasteAttempts: 2, bulkInsert: 1, ipChanges: 1, locationFlags: 1, excessiveTabSwitching: 1 });
  assert.equal(Object.values(b).reduce((a, c) => a + c, 0), flagScore({ integrity: { ...integrity, tabHidden: 3 }, location }));
});
