// modules/exam/flagScore.ts
// The one review-flag number the admin lists show, and its breakdown. Blocked
// paste/copy/cut/drop, bulk inserts, IP changes and location flags each count;
// tab switching counts once, only when it happened TAB_HIDDEN_THRESHOLD or more
// times (an occasional switch is normal), and window blur alone never counts.
// The breakdown sums to the score so a badge and its tooltip always agree.

import type { IntegrityCounts } from './exam.service.js';
import type { LocationFlag } from './locationFlags.js';

export const TAB_HIDDEN_THRESHOLD = 3;

export interface CandidateFlags {
  integrity: IntegrityCounts;
  location: LocationFlag[];
  /** Other candidates who started within 100 m and ±2 h; null without a granted start location. Not part of the flag score. */
  nearbyCount: number | null;
}

export type FlagBreakdown = {
  pasteAttempts: number;
  bulkInsert: number;
  ipChanges: number;
  locationFlags: number;
  excessiveTabSwitching: number;
};

export function flagBreakdown(f: Pick<CandidateFlags, 'integrity' | 'location'>): FlagBreakdown {
  return {
    pasteAttempts: f.integrity.pasteAttempts,
    bulkInsert: f.integrity.bulkInsert,
    ipChanges: f.integrity.ipChanges,
    locationFlags: f.location.length,
    excessiveTabSwitching: f.integrity.tabHidden >= TAB_HIDDEN_THRESHOLD ? 1 : 0,
  };
}

export function flagScore(f: Pick<CandidateFlags, 'integrity' | 'location'>): number {
  return Object.values(flagBreakdown(f)).reduce((a, b) => a + b, 0);
}
