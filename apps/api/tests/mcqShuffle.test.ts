// Per-attempt question list (spec 2026-11-10 MCQ questions): MCQs first in a
// shuffled order with their options shuffled (correct index re-mapped to the
// shown order), written questions after in display order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAttemptQuestions, type ActiveQuestion } from '../src/modules/exam/mcqShuffle.js';

const w = (id: string): ActiveQuestion => ({ id, type: 'WRITTEN', text: `W ${id}`, maxMarks: 5, options: [], correctOption: null });
const m = (id: string, correct = 1): ActiveQuestion => ({ id, type: 'MCQ', text: `M ${id}`, maxMarks: 1, options: [`${id}-a`, `${id}-b`, `${id}-c`, `${id}-d`], correctOption: correct });

/** Deterministic "random" from a seed (LCG), for reproducible shuffles. */
const seeded = (seed: number) => {
  let s = seed;
  return (n: number) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s % n;
  };
};

test('MCQs come first, written keep display order', () => {
  const out = buildAttemptQuestions([w('w1'), m('m1'), w('w2'), m('m2'), m('m3')], seeded(7));
  assert.deepEqual(out.map((q) => q.type), ['MCQ', 'MCQ', 'MCQ', 'WRITTEN', 'WRITTEN']);
  assert.deepEqual(out.slice(3).map((q) => q.questionId), ['w1', 'w2']);
  assert.deepEqual(out.slice(0, 3).map((q) => q.questionId).sort(), ['m1', 'm2', 'm3']);
  for (const q of out.slice(3)) assert.deepEqual([q.options, q.correct], [[], null]);
});

test('options are a permutation and correctSnapshot follows the correct text', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const [q] = buildAttemptQuestions([m('x', 2)], seeded(seed));
    assert.deepEqual([...q!.options].sort(), ['x-a', 'x-b', 'x-c', 'x-d']);
    assert.equal(q!.options[q!.correct!], 'x-c', `seed ${seed}`);
  }
});

test('two seeds give different orders', () => {
  const qs = Array.from({ length: 8 }, (_, i) => m(`q${i}`));
  const a = buildAttemptQuestions(qs, seeded(1)).map((q) => q.questionId + q.options.join());
  const b = buildAttemptQuestions(qs, seeded(2)).map((q) => q.questionId + q.options.join());
  assert.notDeepEqual(a, b);
});

test('the default random source is crypto-based and still keeps the rules', () => {
  const out = buildAttemptQuestions([w('w1'), m('m1', 0)]);
  assert.deepEqual(out.map((q) => q.type), ['MCQ', 'WRITTEN']);
  assert.equal(out[0]!.options[out[0]!.correct!], 'm1-a');
});
