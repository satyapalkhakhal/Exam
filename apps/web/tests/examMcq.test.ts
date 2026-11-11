import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerValue, decodeChoice, encodeChoice, isAnswered, negativeMarkingText, paletteGroups, toChoiceBody } from '../src/lib/examMcq.js';
import type { ExamQuestion } from '../src/types/exam.js';

const q = (id: string, order: number, type: 'MCQ' | 'WRITTEN', over: Partial<ExamQuestion['answer']> = {}): ExamQuestion => ({
  attemptQuestionId: id,
  order,
  type,
  text: `Q ${id}`,
  maxMarks: 1,
  options: type === 'MCQ' ? ['a', 'b', 'c', 'd'] : [],
  answer: { text: '', wordCount: 0, selectedOption: null, clientSeq: 0, markedForReview: false, visited: false, lastSavedAt: null, ...over },
});

test('palette groups MCQs before written and counts a chosen option as answered', () => {
  const questions = [q('w1', 3, 'WRITTEN'), q('m1', 1, 'MCQ'), q('m2', 2, 'MCQ')];
  const answers = {
    m1: { text: encodeChoice(2), markedForReview: false, visited: true },
    m2: { text: '', markedForReview: false, visited: true },
    w1: { text: 'some words here', markedForReview: false, visited: true },
  };
  const groups = paletteGroups(questions, answers);
  assert.deepEqual(groups.map((g) => g.title), ['Multiple choice', 'Written']);
  assert.deepEqual(groups[0]!.items.map((i) => [i.id, i.number, i.state]), [['m1', 1, 'answered'], ['m2', 2, 'unanswered']]);
  assert.deepEqual(groups[1]!.items.map((i) => [i.id, i.number, i.state]), [['w1', 3, 'answered']]);
  // A test with no MCQs keeps a single group.
  assert.deepEqual(paletteGroups([q('w1', 1, 'WRITTEN')], { w1: { text: '', markedForReview: true, visited: true } }).map((g) => [g.title, g.items[0]!.state]), [['Written', 'marked']]);
});

test('negativeMarkingText(0.25)', () => {
  assert.equal(negativeMarkingText(0.25), 'Wrong MCQ answers: −0.25 marks. Unanswered: 0.');
  assert.equal(negativeMarkingText(1), 'Wrong MCQ answers: −1 marks. Unanswered: 0.');
  assert.equal(negativeMarkingText(0), null);
});

test('choice encoding round-trips; the answer value of an MCQ is its encoded choice', () => {
  assert.equal(encodeChoice(null), '');
  assert.equal(decodeChoice(encodeChoice(3)), 3);
  assert.equal(decodeChoice(''), null);
  assert.equal(decodeChoice('x'), null);
  assert.equal(answerValue(q('m', 1, 'MCQ', { selectedOption: 1, text: '' })), '1');
  assert.equal(answerValue(q('w', 1, 'WRITTEN', { text: 'hello' })), 'hello');
  assert.equal(isAnswered('MCQ', '0'), true);
  assert.equal(isAnswered('MCQ', ''), false);
  assert.equal(isAnswered('WRITTEN', '  '), false);
});

test('toChoiceBody maps an autosave payload to the choice endpoint body', () => {
  const base = { attemptQuestionId: 'm', clientSeq: 4, typedChars: 0, restoredChars: 0, intervalMs: 10 };
  assert.deepEqual(toChoiceBody({ ...base, text: '2', visited: true }), { clientSeq: 4, selectedOption: 2, visited: true });
  assert.deepEqual(toChoiceBody({ ...base, text: '', markedForReview: true }), { clientSeq: 4, selectedOption: null, markedForReview: true });
});
