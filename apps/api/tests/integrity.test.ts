// The server-side bulk-insert evidence (design §7.4): growth beyond what was
// typed, or a typing rate no human sustains, flags the save.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessSave } from '../src/modules/exam/integrity.js';

test('600 new characters with nothing typed is GROWTH_EXCEEDS_TYPED', () => {
  const r = assessSave({ prevLength: 0, newLength: 600, typedChars: 0, intervalMs: 3000 });
  assert.equal(r.flagged, true);
  assert.deepEqual(r.reasons, ['GROWTH_EXCEEDS_TYPED']);
  assert.equal(r.grown, 600);
});

test('60 characters with 40 typed over 3 s is within the 50-character slack', () => {
  const r = assessSave({ prevLength: 0, newLength: 60, typedChars: 40, intervalMs: 3000 });
  assert.equal(r.flagged, false);
  assert.deepEqual(r.reasons, []);
});

test('60 typed in 2 s (30/s) is TYPING_RATE', () => {
  const r = assessSave({ prevLength: 100, newLength: 160, typedChars: 60, intervalMs: 2000 });
  assert.equal(r.flagged, true);
  assert.deepEqual(r.reasons, ['TYPING_RATE']);
  assert.equal(r.rate, 30);
});

test('a deletion is not flagged', () => {
  const r = assessSave({ prevLength: 100, newLength: 80, typedChars: 0, intervalMs: 2000 });
  assert.equal(r.flagged, false);
  assert.equal(r.grown, -20);
});

test('the rate check needs at least 1 s of interval', () => {
  const r = assessSave({ prevLength: 0, newLength: 20, typedChars: 20, intervalMs: 500 });
  assert.equal(r.flagged, false);
  assert.equal(r.rate, 0);
});

test('both reasons can apply at once', () => {
  const r = assessSave({ prevLength: 0, newLength: 1000, typedChars: 100, intervalMs: 2000 });
  assert.deepEqual(r.reasons, ['GROWTH_EXCEEDS_TYPED', 'TYPING_RATE']);
});

test('I4: Undo restoring a deleted sentence (reported as restoredChars) is not flagged, and is not typing speed', () => {
  const r = assessSave({ prevLength: 1000, newLength: 1400, typedChars: 0, restoredChars: 400, intervalMs: 2000 });
  assert.equal(r.flagged, false);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.rate, 0);
});

test('I4: restoredChars excuses only what it covers; extra growth still flags', () => {
  const r = assessSave({ prevLength: 1000, newLength: 1600, typedChars: 0, restoredChars: 400, intervalMs: 2000 });
  assert.deepEqual(r.reasons, ['GROWTH_EXCEEDS_TYPED']);
});
