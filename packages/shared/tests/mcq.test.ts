import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuestionCreateSchema, QuestionUpdateSchema, mcqLetter } from '../src/schemas/questions.js';
import { RoundSettingsSchema } from '../src/schemas/drives.js';
import { SaveChoiceSchema } from '../src/schemas/exam.js';

const roundId = '11111111-1111-4111-8111-111111111111';
const base = { roundId, questionText: 'Which number is prime?', maxMarks: 1 };
const sid = '22222222-2222-4222-8222-222222222222';

test('MCQ needs exactly 4 distinct options and a correct option', () => {
  const ok = QuestionCreateSchema.safeParse({ ...base, type: 'MCQ', options: [' 4 ', '6', '7', '9'], correctOption: 2 });
  assert.equal(ok.success, true);
  assert.deepEqual(ok.success && ok.data.options, ['4', '6', '7', '9']);
  const bad = (over: object) => QuestionCreateSchema.safeParse({ ...base, type: 'MCQ', options: ['4', '6', '7', '9'], correctOption: 0, ...over }).success;
  assert.equal(bad({ options: ['4', '6', '7'] }), false, '3 options');
  assert.equal(bad({ options: ['4', '6', '7', '9', '11'] }), false, '5 options');
  assert.equal(bad({ options: ['4', '6', 'Seven', 'seven'] }), false, 'duplicate (case-insensitive)');
  assert.equal(bad({ options: ['4', '', '7', '9'] }), false, 'empty option');
  assert.equal(bad({ correctOption: 4 }), false, 'correct out of range');
  assert.equal(bad({ correctOption: undefined }), false, 'no correct');
});

test('written refuses options; type defaults to WRITTEN', () => {
  const w = QuestionCreateSchema.safeParse({ ...base, questionText: 'Explain idempotency in HTTP.' });
  assert.equal(w.success && w.data.type, 'WRITTEN');
  assert.equal(QuestionCreateSchema.safeParse({ ...base, type: 'WRITTEN', options: ['a', 'b', 'c', 'd'] }).success, false);
  assert.equal(QuestionCreateSchema.safeParse({ ...base, type: 'WRITTEN', correctOption: 1 }).success, false);
  assert.equal(QuestionUpdateSchema.safeParse({ options: ['a', 'b', 'c', 'd'], correctOption: 3 }).success, true);
  assert.equal(QuestionUpdateSchema.safeParse({ options: ['a', 'b', 'c'] }).success, false);
});

test('negative marks must be a multiple of 0.25', () => {
  const p = (n: number) => RoundSettingsSchema.safeParse({ durationMinutes: 60, mcqNegativeMarks: n }).success;
  assert.equal(p(0), true);
  assert.equal(p(0.25), true);
  assert.equal(p(1.5), true);
  assert.equal(p(0.3), false);
  assert.equal(p(-0.25), false);
});

test('SaveChoiceSchema allows null to clear; option 0–3 only', () => {
  const p = (selectedOption: unknown) => SaveChoiceSchema.safeParse({ sessionId: sid, clientSeq: 1, selectedOption }).success;
  assert.equal(p(null), true);
  assert.equal(p(3), true);
  assert.equal(p(4), false);
  assert.equal(p(1.5), false);
});

test('mcqLetter maps 0..3 to A..D', () => {
  assert.deepEqual([0, 1, 2, 3].map(mcqLetter), ['A', 'B', 'C', 'D']);
});
