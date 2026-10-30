import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords } from '../src/wordCount.js';

test('countWords', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('  a  b\n\tc '), 3);
  assert.equal(countWords('नमस्ते दुनिया'), 2);
});
