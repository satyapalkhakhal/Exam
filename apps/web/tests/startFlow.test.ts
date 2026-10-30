import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialStartFlow, startFlowReducer as r } from '../src/lib/startFlow.js';

test('begin locks Start and a second begin is a no-op', () => {
  const a = r(initialStartFlow, { type: 'begin' });
  assert.equal(a.locating, true);
  assert.equal(r(a, { type: 'begin' }), a);
});

test('location problem unlocks and shows the alert; begin clears it', () => {
  const a = r(r(initialStartFlow, { type: 'begin' }), { type: 'locationProblem', permission: 'DENIED' });
  assert.deepEqual(a, { locating: false, alert: 'DENIED', error: null });
  assert.deepEqual(r(a, { type: 'begin' }), { locating: true, alert: null, error: null });
});

test('recovered clears the alert; failed keeps a message and unlocks', () => {
  const a = r({ locating: true, alert: 'TIMEOUT', error: null }, { type: 'recovered' });
  assert.deepEqual(a, { locating: false, alert: null, error: null });
  assert.deepEqual(r({ ...a, locating: true }, { type: 'failed', message: 'x' }), { locating: false, alert: null, error: 'x' });
});

test('a failed save during a retry keeps a retryable alert', () => {
  const asked = r({ locating: false, alert: 'DENIED', error: null }, { type: 'begin' });
  assert.equal(asked.alert, null);
  const a = r(asked, { type: 'saveFailed' });
  assert.deepEqual(a, { locating: false, alert: 'SAVE_FAILED', error: null });
  assert.equal(r(a, { type: 'begin' }).locating, true);
});
