// modules/exam/mcqShuffle.ts
// The per-attempt question list (spec 2026-11-10 MCQ questions): MCQs first, in
// an order shuffled for this candidate, each with its 4 options shuffled and the
// correct index re-mapped to the shown order; written questions after, in display
// order. Neighbours in an exam hall therefore see different MCQ and option orders.
// `rand(n)` returns an integer in [0, n); the default is crypto-random.

import crypto from 'node:crypto';

export interface ActiveQuestion {
  id: string;
  type: 'WRITTEN' | 'MCQ';
  text: string;
  maxMarks: number;
  options: string[];
  correctOption: number | null;
}

export interface AttemptQuestionInput {
  questionId: string;
  type: 'WRITTEN' | 'MCQ';
  text: string;
  maxMarks: number;
  /** MCQ: the options in the order this candidate sees them; [] for written. */
  options: string[];
  /** MCQ: index of the correct option in `options`; null for written. */
  correct: number | null;
}

const cryptoRand = (n: number): number => crypto.randomInt(n);

/** Fisher–Yates on a copy. */
function shuffled<T>(items: T[], rand: (n: number) => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function buildAttemptQuestions(questions: ActiveQuestion[], rand: (n: number) => number = cryptoRand): AttemptQuestionInput[] {
  const mcqs = shuffled(
    questions.filter((q) => q.type === 'MCQ'),
    rand,
  ).map((q) => {
    const order = shuffled([0, 1, 2, 3].slice(0, q.options.length), rand);
    return {
      questionId: q.id,
      type: 'MCQ' as const,
      text: q.text,
      maxMarks: q.maxMarks,
      options: order.map((k) => q.options[k]!),
      correct: q.correctOption === null ? null : order.indexOf(q.correctOption),
    };
  });
  const written = questions
    .filter((q) => q.type !== 'MCQ')
    .map((q) => ({ questionId: q.id, type: 'WRITTEN' as const, text: q.text, maxMarks: q.maxMarks, options: [], correct: null }));
  return [...mcqs, ...written];
}
