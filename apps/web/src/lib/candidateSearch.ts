// src/lib/candidateSearch.ts
// Why: client-side search for lists that are already fully loaded (the leaderboard):
// one box matching name, email, roll number or candidate code, like the Candidates list.

export interface SearchableCandidate {
  fullName?: string | null;
  email?: string | null;
  rollNumber?: string | null;
  candidateCode?: string | null;
}

export function matchesCandidateSearch(c: SearchableCandidate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [c.fullName, c.email, c.rollNumber, c.candidateCode].some((v) => (v ?? '').toLowerCase().includes(q));
}
