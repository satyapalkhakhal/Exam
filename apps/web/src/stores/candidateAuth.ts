// src/stores/candidateAuth.ts
// Why: the signed-in candidate for the guards and exam screens. Not persisted;
// the cookies are the session and /me rehydrates this on reload.

import { create } from 'zustand';
import type { CandidateSelf } from '../types/auth.js';

interface CandidateAuthState {
  candidate: CandidateSelf | null;
  setCandidate: (candidate: CandidateSelf) => void;
  clear: () => void;
}

export const useCandidateAuth = create<CandidateAuthState>((set) => ({
  candidate: null,
  setCandidate: (candidate) => set({ candidate }),
  clear: () => set({ candidate: null }),
}));

/**
 * Mirror an exam status change into the signed-in candidate. /me is not
 * refetched while the store is set, so without this a candidate who goes Back
 * from /exam after Start sees Start (or "window closed") instead of Resume.
 */
export function markCandidateStatus(status: string): void {
  const c = useCandidateAuth.getState().candidate;
  if (c && c.status !== status) useCandidateAuth.getState().setCandidate({ ...c, status });
}
