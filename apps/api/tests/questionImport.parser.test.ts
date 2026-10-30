// tests/questionImport.parser.test.ts
// Row-level validation and duplicate detection for the question import.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_CSV, parseQuestionRows } from '../src/modules/questions/questionImport.parser.js';
import { readSheet } from '../src/shared/utils/spreadsheet.js';
import { normalizeQuestionText, questionHash } from '../src/shared/utils/questionHash.js';

const q = (text: string, marks = '5', extra: Record<string, string> = {}) => ({
  question_text: text,
  max_marks: marks,
  ...extra,
});

test('same text differing in case and whitespace is an IN_FILE duplicate at row 3', () => {
  const r = parseQuestionRows([q('Explain  the CAP theorem'), q('  explain the cap THEOREM ')], new Set());
  assert.equal(r.valid.length, 1);
  assert.deepEqual(r.duplicates, [{ row: 3, reason: 'IN_FILE' }]);
});

test('a hash already stored for the role is EXISTS', () => {
  const existing = new Set([questionHash('Explain the CAP theorem')]);
  const r = parseQuestionRows([q('explain the   cap theorem')], existing);
  assert.equal(r.valid.length, 0);
  assert.deepEqual(r.duplicates, [{ row: 2, reason: 'EXISTS' }]);
});

test('max_marks 7.3 is an error on row 2', () => {
  const r = parseQuestionRows([q('A sufficiently long question', '7.3')], new Set());
  assert.equal(r.valid.length, 0);
  assert.equal(r.errors[0]?.row, 2);
  assert.equal(r.errors[0]?.field, 'max_marks');
});

test('max_marks bounds: 0.5 and 100 pass, 0, 100.5 and text fail', () => {
  const rows = ['0.5', '100', '0', '100.5', 'abc', ''].map((m, i) => q(`Question number ${i} here`, m));
  const r = parseQuestionRows(rows, new Set());
  assert.deepEqual(r.valid.map((v) => v.maxMarks), [0.5, 100]);
  assert.deepEqual(r.errors.map((e) => e.row), [4, 5, 6, 7]);
});

test('question_text length 10..5000', () => {
  const r = parseQuestionRows([q('short'), q('x'.repeat(5001)), q('x'.repeat(10)), q('y'.repeat(5000))], new Set());
  assert.equal(r.valid.length, 2);
  assert.deepEqual(r.errors.map((e) => [e.row, e.field]), [[2, 'question_text'], [3, 'question_text']]);
});

test('display_order and guidance are read; blank order is null; bad order is an error', () => {
  const r = parseQuestionRows(
    [
      q('First question text', '5', { evaluator_guidance: 'look for X', display_order: '3' }),
      q('Second question text', '5', { display_order: '' }),
      q('Third question text', '5', { display_order: '-1' }),
    ],
    new Set(),
  );
  assert.equal(r.valid[0]?.displayOrder, 3);
  assert.equal(r.valid[0]?.evaluatorGuidance, 'look for X');
  assert.equal(r.valid[1]?.displayOrder, null);
  assert.equal(r.valid[1]?.evaluatorGuidance, null);
  assert.deepEqual(r.errors.map((e) => [e.row, e.field]), [[4, 'display_order']]);
});

test('an erroring row does not register its hash as a duplicate source', () => {
  const r = parseQuestionRows([q('Valid question text', '7.3'), q('Valid question text', '5')], new Set());
  assert.equal(r.valid.length, 1);
  assert.equal(r.duplicates.length, 0);
});

test('normalizeQuestionText trims, collapses whitespace and lower-cases', () => {
  assert.equal(normalizeQuestionText('  Hello \n\t World  '), 'hello world');
});

test('rowNumbers override the positional row numbers in errors', () => {
  const r = parseQuestionRows([q('Valid question text', '7.3')], new Set(), [9]);
  assert.equal(r.errors[0]?.row, 9);
});

test('the downloadable sample CSV imports cleanly: 6 valid rows, no errors', async () => {
  const sheet = await readSheet(Buffer.from(SAMPLE_CSV), 'questions-sample.csv');
  const r = parseQuestionRows(sheet.rows, new Set(), sheet.rowNumbers);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.duplicates, []);
  assert.equal(r.valid.length, 6);
});
