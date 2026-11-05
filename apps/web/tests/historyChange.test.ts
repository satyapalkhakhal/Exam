import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyChangeText } from '../src/lib/historyChange.js';

const h = (fromStatus: string | null, toStatus: string, fromResult: 'SHORTLISTED' | 'REJECTED' | null = null, toResult: 'SHORTLISTED' | 'REJECTED' | null = null) => ({
  fromStatus,
  toStatus,
  fromResult,
  toResult,
});

test('historyChangeText: a status change reads as before', () => {
  assert.equal(historyChangeText(h('SUBMITTED', 'EVALUATED')), 'Submitted to Evaluated');
  assert.equal(historyChangeText(h(null, 'NOT_STARTED')), 'Not started');
});

test('historyChangeText: a decision shows only the result change', () => {
  assert.equal(historyChangeText(h('EVALUATED', 'EVALUATED', null, 'SHORTLISTED')), 'Result: None to Shortlisted');
  assert.equal(historyChangeText(h('EVALUATED', 'EVALUATED', 'SHORTLISTED', 'REJECTED')), 'Result: Shortlisted to Rejected');
});

test('historyChangeText: a reopen or reset shows both changes', () => {
  assert.equal(historyChangeText(h('EVALUATED', 'SUBMITTED', 'REJECTED', null)), 'Evaluated to Submitted; Result: Rejected to None');
});

test('historyChangeText: an old row whose status was the decision still reads', () => {
  assert.equal(historyChangeText(h('EVALUATED', 'SHORTLISTED')), 'Evaluated to Shortlisted');
});
