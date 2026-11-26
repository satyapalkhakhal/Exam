import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readResetToken } from '../src/lib/resetToken.js';

test('reads the token from a #token= fragment', () => {
  assert.equal(readResetToken('#token=abc_DEF-123'), 'abc_DEF-123');
});

test('no or empty token → null', () => {
  assert.equal(readResetToken(''), null);
  assert.equal(readResetToken('#'), null);
  assert.equal(readResetToken('#token='), null);
  assert.equal(readResetToken('#other=1'), null);
});
