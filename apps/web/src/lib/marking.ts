// src/lib/marking.ts
// Why: the marking screen's pure rules. validateMarksClient mirrors the API's
// validateMarks (0..max in steps of 0.5) so the evaluator sees the problem before
// saving; the server stays authoritative.

export interface MarkedItem {
  marks: number | null;
}

export function sumMarks(items: readonly MarkedItem[]): number {
  return items.reduce((t, i) => t + (i.marks ?? 0), 0);
}

export function canSubmitEvaluation(items: readonly MarkedItem[]): boolean {
  return items.length > 0 && items.every((i) => i.marks !== null);
}

/**
 * Drafts are seeded once, and only from marking data fetched after the lock request
 * settled. A cached copy from an earlier visit may predate another evaluator's marks;
 * seeding (and then saving) from it would silently overwrite them.
 */
export function shouldSeedDrafts(s: { seeded: boolean; lockSettledAt: number | null; dataUpdatedAt: number; isFetching: boolean }): boolean {
  return !s.seeded && s.lockSettledAt !== null && !s.isFetching && s.dataUpdatedAt >= s.lockSettledAt;
}

/** Returns an error message, or null when the mark is acceptable. */
export function validateMarksClient(marks: number, max: number): string | null {
  if (!Number.isFinite(marks)) return 'Enter a number';
  if (marks < 0) return 'Marks cannot be negative';
  if (marks > max) return `Maximum is ${max}`;
  if (!Number.isInteger(marks * 2)) return 'Use steps of 0.5';
  return null;
}

// ---- MCQ questions (spec 2026-11-10) ------------------------------------------
// MCQs are auto-marked at submit: the evaluator never sends marks for them (the API
// refuses), so drafts, completeness and the items sent cover written questions only.

export interface MarkableQuestion {
  attemptQuestionId: string;
  type: 'WRITTEN' | 'MCQ';
  maxMarks: number;
}

/** Written questions with their parsed draft marks (blank = null), in the given order. */
export function writtenRows<Q extends MarkableQuestion>(questions: readonly Q[], drafts: Readonly<Record<string, { marks: string; comment?: string } | undefined>>): { q: Q; marks: number | null }[] {
  return questions
    .filter((q) => q.type !== 'MCQ')
    .map((q) => {
      const s = drafts[q.attemptQuestionId]?.marks ?? '';
      return { q, marks: s.trim() === '' ? null : Number(s) };
    });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Running total shown while marking: written drafts + MCQ subtotal, floored at 0 like the server. */
export function markingTotal(rows: readonly { marks: number | null }[], writtenMax: number, mcqMarks: number | null, mcqMaxMarks: number): { total: number; max: number } {
  return { total: Math.max(0, round2(sumMarks(rows) + (mcqMarks ?? 0))), max: round2(writtenMax + mcqMaxMarks) };
}

/** Submissions / leaderboard "MCQ" column. */
export function mcqCell(r: { mcqMarks: number | null; mcqMaxMarks: number }): string {
  return r.mcqMaxMarks > 0 && r.mcqMarks !== null ? `${r.mcqMarks} / ${r.mcqMaxMarks}` : '-';
}
