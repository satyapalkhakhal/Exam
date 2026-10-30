// csvEscape: export cells that a spreadsheet would read as a formula get a
// leading apostrophe (design §13, formula injection on export).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvEscape } from '../src/shared/utils/csvEscape.js';

test('a formula-looking string is prefixed with an apostrophe', () => {
  assert.equal(csvEscape('=SUM(A1)'), "'=SUM(A1)");
  for (const s of ['+1', '-2', '@cmd', '\tx', '\rx']) assert.equal(csvEscape(s), `'${s}`);
});

test('ordinary strings and non-strings are unchanged', () => {
  assert.equal(csvEscape('Ajith'), 'Ajith');
  assert.equal(csvEscape(''), '');
  assert.equal(csvEscape(-3), -3);
  assert.equal(csvEscape(null), null);
});
