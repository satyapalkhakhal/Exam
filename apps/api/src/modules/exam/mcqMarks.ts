// modules/exam/mcqMarks.ts
// The MCQ scoring rule (spec 2026-11-10 MCQ questions), pure so it is unit
// tested and identical wherever marks are (re)computed: the right option earns
// the question's marks, a wrong one costs the round's negative marks, an
// unanswered one scores 0. The subtotal may be negative; the overall attempt
// total is floored at 0 by whoever combines it with the written marks.

export interface McqScoreInput {
  maxMarks: number;
  /** Correct index in the shown order. */
  correct: number;
  /** Marks deducted for a wrong answer (0 = none). */
  negative: number;
}

/** Marks to two decimals, so quarter deductions add up exactly. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function scoreMcq(q: McqScoreInput, selected: number | null): number {
  if (selected === null) return 0;
  if (selected === q.correct) return q.maxMarks;
  return q.negative === 0 ? 0 : round2(-q.negative);
}

export interface McqSubtotal {
  marks: number[];
  total: number;
  max: number;
  correct: number;
  wrong: number;
  unanswered: number;
}

export function mcqSubtotal(items: (McqScoreInput & { selected: number | null })[]): McqSubtotal {
  const marks = items.map((i) => scoreMcq(i, i.selected));
  return {
    marks,
    total: round2(marks.reduce((a, b) => a + b, 0)),
    max: round2(items.reduce((a, i) => a + i.maxMarks, 0)),
    correct: items.filter((i) => i.selected !== null && i.selected === i.correct).length,
    wrong: items.filter((i) => i.selected !== null && i.selected !== i.correct).length,
    unanswered: items.filter((i) => i.selected === null).length,
  };
}
