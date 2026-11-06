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
  percentage: number;
  questionMarks: { order: number; marks: number | null; aiMarks: number | null; maxMarks: number }[];
  aiPercentage: number | null;
  compositeScore: number | null;
  compositeProvisional: boolean;
  flagCounts: Record<string, number>;
  nearbyCount: number | null;
}

export type Decision = 'SHORTLISTED' | 'REJECTED';

export function useLeaderboard(jobRoleId: string, sort: LeaderboardSort = 'human') {
  return useQuery({
    queryKey: ['admin', 'leaderboard', jobRoleId, sort],
    enabled: Boolean(jobRoleId),
    queryFn: async () => {
      const r = await apiFetch<Paged<LeaderboardRow> | LeaderboardRow[]>('admin', `/leaderboard?jobRoleId=${encodeURIComponent(jobRoleId)}&sort=${sort}`);
      return Array.isArray(r) ? r : r.items;
    },
  });
}

export const resultsExportUrl = (jobRoleId: string) => `/api/admin/exports/results.xlsx?jobRoleId=${encodeURIComponent(jobRoleId)}`;
export const activityExportUrl = (jobRoleId: string) => `/api/admin/exports/activity.xlsx?jobRoleId=${encodeURIComponent(jobRoleId)}`;

/** Shortlist / reject several candidates; with sendEmail the matching email is queued too. */
export function useBulkDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CandidateDecisionBulkInput) =>
      apiFetch<CandidateDecisionBulkResultDto>('admin', '/candidates/bulk/result', { method: 'POST', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
}
