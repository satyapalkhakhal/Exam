import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionsSummary, questionFormSchema, toQuestionPayload, type QuestionFormValues } from '../src/lib/mcqForm.js';

const base: QuestionFormValues = {
  type: 'MCQ',
  questionText: 'Which of these is prime?',
  maxMarks: 2,
  evaluatorGuidance: '  ',
  options: [' 4 ', '6', ' 7', '9 '],
  correctOption: 2,
};

test('mcqForm: payload for MCQ has 4 trimmed options and correctOption; written has none', () => {
  assert.deepEqual(toQuestionPayload(base, false), {
    type: 'MCQ',
    questionText: 'Which of these is prime?',
    maxMarks: 2,
    evaluatorGuidance: null,
    options: ['4', '6', '7', '9'],
    correctOption: 2,
  });
  const written = toQuestionPayload({ ...base, type: 'WRITTEN', evaluatorGuidance: ' Mentions X ' }, false);
  assert.deepEqual(written, { type: 'WRITTEN', questionText: 'Which of these is prime?', maxMarks: 2, evaluatorGuidance: 'Mentions X' });
  assert.ok(!('options' in written) && !('correctOption' in written));
  // Editing never sends the type (it cannot change).
  assert.ok(!('type' in toQuestionPayload(base, true)));
  assert.deepEqual(toQuestionPayload(base, true).options, ['4', '6', '7', '9']);
});

test('mcqForm: an MCQ needs 4 different options and a correct answer; a written question ignores them', () => {
  const issues = (v: QuestionFormValues) => {
    const r = questionFormSchema.safeParse(v);
    return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
  };
  assert.deepEqual(issues(base), []);
  assert.deepEqual(issues({ ...base, options: ['4', '', '7', '9'] }), ['options.1']);
  assert.deepEqual(issues({ ...base, options: ['4', '6', ' 4', '9'] }), ['options.2']);
  assert.deepEqual(issues({ ...base, correctOption: null }), ['correctOption']);
  assert.deepEqual(issues({ ...base, type: 'WRITTEN', options: ['', '', '', ''], correctOption: null }), []);
});

test('mcqForm: options summary marks the correct one', () => {
  assert.equal(optionsSummary(['4', '6', '7', '9'], 2), 'A. 4 · B. 6 · C. 7 ✓ · D. 9');
  assert.equal(optionsSummary([], null), '');
});
