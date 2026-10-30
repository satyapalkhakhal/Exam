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
