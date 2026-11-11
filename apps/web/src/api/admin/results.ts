// src/api/admin/results.ts
// Why: leaderboard, bulk shortlist/reject decisions and XLSX export links (plan Task 11).
// Leaderboard row fields beyond the plan's prose ("rank, PII, per-question marks and
// flag counts") are assumed; see task-17-report.md.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { SaPii } from './evaluation';
import type { Paged } from './users';
import type { LeaderboardSort, CandidateDecisionBulkInput, CandidateDecisionBulkResultDto } from '@exam/shared';

export interface LeaderboardRow extends SaPii {
  rank: number;
  candidateCode: string;
  status: string;
  result: 'SHORTLISTED' | 'REJECTED' | null;
  submittedAt: string | null;
  totalMarks: number;
  maxMarks: number;
  /** MCQ subtotal (auto-marked) and its max; null / 0 when the test has no MCQs. */
  mcqMarks: number | null;
  mcqMaxMarks: number;
  percentage: number;
  questionMarks: { order: number; marks: number | null; aiMarks: number | null; maxMarks: number }[];
  aiPercentage: number | null;
  compositeScore: number | null;
  compositeProvisional: boolean;
  flagCounts: Record<string, number>;
  nearbyCount: number | null;
}

export type Decision = 'SHORTLISTED' | 'REJECTED';

/** One drive's ranking (spec 2026-11-10: colleges, rounds and internships are never mixed). */
export function useLeaderboard(driveId: string, sort: LeaderboardSort = 'human') {
  return useQuery({
    queryKey: ['admin', 'leaderboard', driveId, sort],
    enabled: Boolean(driveId),
    queryFn: async () => {
      const r = await apiFetch<Paged<LeaderboardRow> | LeaderboardRow[]>('admin', `/leaderboard?driveId=${encodeURIComponent(driveId)}&sort=${sort}`);
      return Array.isArray(r) ? r : r.items;
    },
  });
}

export const resultsExportUrl = (driveId: string) => `/api/admin/exports/results.xlsx?driveId=${encodeURIComponent(driveId)}`;
export const activityExportUrl = (driveId: string) => `/api/admin/exports/activity.xlsx?driveId=${encodeURIComponent(driveId)}`;

/** Shortlist / reject several candidates; with sendEmail the matching email is queued too. */
export function useBulkDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CandidateDecisionBulkInput) =>
      apiFetch<CandidateDecisionBulkResultDto>('admin', '/candidates/bulk/result', { method: 'POST', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
}
