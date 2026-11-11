// src/api/admin/aiEvaluation.ts
// Why: AI grading runs and bulk accept (docs/ai-evaluation.md). Runs are polled every 3 s
// only while one is RUNNING; finished runs change submission rows, so those are refetched.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiAcceptInput, AiAcceptResultDto, AiRunDto, AiRunStartInput, AiRunStartResultDto } from '@exam/shared';
import { apiFetch } from '@/lib/api';
import { runsRefetchInterval } from '@/lib/aiEvaluation';

export const aiRunsKey = (driveId: string) => ['admin', 'ai-runs', driveId] as const;

/** Runs of one drive (spec 2026-11-10: AI grading is per drive). */
export function useAiRuns(driveId: string, enabled: boolean) {
  return useQuery({
    queryKey: aiRunsKey(driveId),
    enabled,
    queryFn: async () => {
      const q = driveId ? `?driveId=${encodeURIComponent(driveId)}` : '';
      return (await apiFetch<{ items: AiRunDto[] }>('admin', `/ai-evaluations${q}`)).items;
    },
    refetchInterval: (query) => runsRefetchInterval(query.state.data),
  });
}

export function useStartAiRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AiRunStartInput) => apiFetch<AiRunStartResultDto>('admin', '/ai-evaluations', { method: 'POST', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'ai-runs'] }),
  });
}

export function useCancelAiRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => apiFetch<unknown>('admin', `/ai-evaluations/${runId}/cancel`, { method: 'POST', json: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'ai-runs'] }),
  });
}

export function useBulkAcceptAi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AiAcceptInput) => apiFetch<AiAcceptResultDto>('admin', '/submissions/ai/accept', { method: 'POST', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
}
