// src/api/admin/results.ts
// Why: leaderboard, shortlist/reject decisions and XLSX export links (plan Task 11).
// Leaderboard row fields beyond the plan's prose ("rank, PII, per-question marks and
// flag counts") are assumed; see task-17-report.md.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { SaPii } from './evaluation';
import type { Paged } from './users';

export interface LeaderboardRow extends SaPii {
  rank: number;
  candidateCode: string;
  status: string;
  submittedAt: string | null;
  totalMarks: number;
  maxMarks: number;
  percentage: number;
  questionMarks: { order: number; marks: number | null; maxMarks: number }[];
  flagCounts: Record<string, number>;
}

export type Decision = 'SHORTLISTED' | 'REJECTED';

export function useLeaderboard(jobRoleId: string) {
  return useQuery({
    queryKey: ['admin', 'leaderboard', jobRoleId],
    enabled: Boolean(jobRoleId),
    queryFn: async () => {
      const r = await apiFetch<Paged<LeaderboardRow> | LeaderboardRow[]>('admin', `/leaderboard?jobRoleId=${encodeURIComponent(jobRoleId)}`);
      return Array.isArray(r) ? r : r.items;
    },
  });
}

export function useDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { candidateId: string; decision: Decision; comment?: string }) =>
      apiFetch('admin', `/candidates/${v.candidateId}/decision`, {
        method: 'POST',
        json: v.comment ? { decision: v.decision, comment: v.comment } : { decision: v.decision },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
}

export const resultsExportUrl = (jobRoleId: string) => `/api/admin/exports/results.xlsx?jobRoleId=${encodeURIComponent(jobRoleId)}`;
export const activityExportUrl = (jobRoleId: string) => `/api/admin/exports/activity.xlsx?jobRoleId=${encodeURIComponent(jobRoleId)}`;
