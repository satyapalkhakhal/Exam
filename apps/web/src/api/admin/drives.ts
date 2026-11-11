// src/api/admin/drives.ts
// Why: colleges, rounds and campus drives (spec 2026-11-10), Super Admin only.
// Every write refreshes the job profile list (it embeds rounds and drives).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CollegeDto,
  CompositeWeights,
  CopyQuestionsResultDto,
  DriveDto,
  PromoteResultDto,
  RoundDto,
} from '@exam/shared';
import { apiFetch } from '@/lib/api';
import { rolesKey } from './roles';

export const collegesKey = ['admin', 'colleges'] as const;

/** Super Admin only on the server: pass enabled=false where an Evaluator may be viewing. */
export function useColleges(enabled = true) {
  return useQuery({ queryKey: collegesKey, queryFn: () => apiFetch<CollegeDto[]>('admin', '/colleges'), enabled });
}

export type SaveCollege =
  | { id?: undefined; name: string; shortCode: string }
  | { id: string; name?: string; shortCode?: string; active?: boolean };

export function useSaveCollege() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: SaveCollege) =>
      id
        ? apiFetch<CollegeDto>('admin', `/colleges/${id}`, { method: 'PATCH', json: body })
        : apiFetch<CollegeDto>('admin', '/colleges', { method: 'POST', json: body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: collegesKey });
      void qc.invalidateQueries({ queryKey: rolesKey });
    },
  });
}

function useRefreshRoles() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: rolesKey });
    void qc.invalidateQueries({ queryKey: collegesKey });
  };
}

export function useAddRound() {
  const done = useRefreshRoles();
  return useMutation({
    mutationFn: ({ jobRoleId, name }: { jobRoleId: string; name?: string | null }) =>
      apiFetch<RoundDto>('admin', `/roles/${jobRoleId}/rounds`, { method: 'POST', json: { name: name ?? null } }),
    onSuccess: done,
  });
}

export interface RoundSettings {
  name?: string | null;
  durationMinutes: number;
  weights?: CompositeWeights;
  /** Marks deducted per wrong MCQ answer; omitted keeps the stored value (locked once candidates start). */
  mcqNegativeMarks?: number;
}

export function useUpdateRound() {
  const done = useRefreshRoles();
  return useMutation({
    mutationFn: ({ id, ...body }: RoundSettings & { id: string }) => apiFetch<RoundDto>('admin', `/rounds/${id}`, { method: 'PUT', json: body }),
    onSuccess: done,
  });
}

export interface DriveFields {
  batch: string;
  windowStart: string | null;
  windowEnd: string | null;
  instructions: string;
  isOpen: boolean;
}

/** Create (with roundId + collegeId) or update (with id) a drive. */
export type SaveDrive =
  | ({ id?: undefined; roundId: string; collegeId: string } & DriveFields)
  | ({ id: string } & Partial<DriveFields> & { active?: boolean });

export function useSaveDrive() {
  const done = useRefreshRoles();
  return useMutation({
    mutationFn: (input: SaveDrive) => {
      if (input.id === undefined) {
        const { roundId, id: _none, ...body } = input;
        return apiFetch<DriveDto>('admin', `/rounds/${roundId}/drives`, { method: 'POST', json: body });
      }
      const { id, ...body } = input;
      return apiFetch<DriveDto>('admin', `/drives/${id}`, { method: 'PATCH', json: body });
    },
    onSuccess: done,
  });
}

export function useCopyQuestions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ targetRoundId, fromRoundId, replace }: { targetRoundId: string; fromRoundId: string; replace: boolean }) =>
      apiFetch<CopyQuestionsResultDto>('admin', `/rounds/${targetRoundId}/questions/copy`, { method: 'POST', json: { fromRoundId, replace } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rolesKey });
      void qc.invalidateQueries({ queryKey: ['admin', 'questions'] });
    },
  });
}

/** "Move shortlisted to Round n+1". 409 NEXT_DRIVE_MISSING carries { roundId, collegeId, batch } in details. */
export function usePromote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (driveId: string) => apiFetch<PromoteResultDto>('admin', `/drives/${driveId}/promote`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin'] }),
  });
}
