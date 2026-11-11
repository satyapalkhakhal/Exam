// modules/evaluation/marks.ts
// The marks rules (design §8), enforced server-side whatever the client
// checks: 0…max in steps of 0.5, and the percentage rounded to two places.

import { AppError } from '../../shared/errors.js';

export function validateMarks(marks: number, max: number, attemptQuestionId?: string): void {
  if (!Number.isFinite(marks) || marks < 0 || marks > max || !Number.isInteger(marks * 2)) {
    throw new AppError(
      400,
      'MARKS_OUT_OF_RANGE',
      `Marks must be between 0 and ${max}, in steps of 0.5`,
      attemptQuestionId === undefined ? undefined : { attemptQuestionId },
    );
  }
}

export function percentageOf(total: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((total / max) * 10_000) / 100;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The attempt total (spec 2026-11-10 MCQ questions): written marks plus the MCQ
 * subtotal (null = no MCQs), over the full maximum. Negative marking may take
 * the MCQ part below zero; the total is floored at 0.
 */
export function combinedTotals(written: number, writtenMax: number, mcq: number | null, mcqMax: number): { totalMarks: number; maxMarks: number; percentage: number } {
  const totalMarks = Math.max(0, round2(written + (mcq ?? 0)));
  const maxMarks = round2(writtenMax + mcqMax);
  return { totalMarks, maxMarks, percentage: percentageOf(totalMarks, maxMarks) };
}
