// shared/utils/questionHash.ts
// Duplicate detection for questions is by identical normalised text within a
// role. Normalising (trim, collapse whitespace, lower-case) and hashing live in
// one place so the importer, the CRUD service and the seed always agree.

import { sha256 } from './hash.js';

export const normalizeQuestionText = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();

export const questionHash = (t: string): string => sha256(normalizeQuestionText(t));
