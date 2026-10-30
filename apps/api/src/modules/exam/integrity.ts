// modules/exam/integrity.ts
// The server-side bulk-insert check (design §7.4), the integrity evidence
// admins are told to trust. The client reports how many characters were
// actually typed since its last accepted save; the server compares that with
// how much the stored answer really grew. Either check flags the save, which is
// still accepted: a flag is evidence for review, never a rejection.

export const INTEGRITY_THRESHOLDS = {
  /** Growth allowed beyond the typed count (autocorrect, IME quirks). */
  growthSlackChars: 50,
  /** Sustained typing above this is not a human (~180 wpm). */
  maxCharsPerSecond: 15,
  /** The rate is only meaningful over at least this interval. */
  minRateIntervalMs: 1000,
} as const;

export type BulkInsertReason = 'GROWTH_EXCEEDS_TYPED' | 'TYPING_RATE';

export interface SaveEvidence {
  prevLength: number;
  newLength: number;
  typedChars: number;
  /** Undo/Redo re-insertions (bounded client-side by what was deleted): excused growth, never typing speed. */
  restoredChars?: number;
  intervalMs: number;
}

export interface SaveAssessment {
  flagged: boolean;
  reasons: BulkInsertReason[];
  grown: number;
  rate: number;
}

export function assessSave(e: SaveEvidence): SaveAssessment {
  const t = INTEGRITY_THRESHOLDS;
  const grown = e.newLength - e.prevLength;
  const rate = e.intervalMs >= t.minRateIntervalMs ? e.typedChars / (e.intervalMs / 1000) : 0;
  const reasons: BulkInsertReason[] = [];
  if (grown > e.typedChars + (e.restoredChars ?? 0) + t.growthSlackChars) reasons.push('GROWTH_EXCEEDS_TYPED');
  if (rate > t.maxCharsPerSecond) reasons.push('TYPING_RATE');
  return { flagged: reasons.length > 0, reasons, grown, rate: Math.round(rate * 100) / 100 };
}
