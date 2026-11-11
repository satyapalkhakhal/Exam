// shared/utils/questionHash.ts
// Duplicate detection for questions is by identical normalised text within a
// role. Normalising (trim, collapse whitespace, lower-case) and hashing live in
// one place so the importer, the CRUD service and the seed always agree.

import { sha256 } from './hash.js';

export const normalizeQuestionText = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();

export const questionHash = (t: string): string => sha256(normalizeQuestionText(t));

/**
 * An MCQ's duplicate key covers its text and its 4 options (A–D order), so the
 * same wording ("Find the odd one out") with different options is a different
 * question (spec 2026-11-10 MCQ questions).
 */
export const mcqHash = (t: string, options: string[]): string =>
  sha256([normalizeQuestionText(t), ...options.map(normalizeQuestionText)].join('\u0001'));

/** The duplicate key for either question type. */
export const hashFor = (q: { type: 'WRITTEN' | 'MCQ'; text: string; options: string[] }): string =>
  q.type === 'MCQ' ? mcqHash(q.text, q.options) : questionHash(q.text);
