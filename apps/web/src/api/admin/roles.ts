// src/api/admin/roles.ts
// Why: job roles and their exam settings (plan Task 7). The ExamSettingDto field names
// are assumed (the plan lists only the PUT body): durationMinutes, windowStart/windowEnd
// (ISO UTC | null), instructions, isOpen, questionsLocked.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface ExamSettingDto {
  durationMinutes: number;
  windowStart: string | null;
  windowEnd: string | null;
  instructions: string;
  isOpen: boolean;
  questionsLocked: boolean;
}

export interface JobRole {
  id: string;
  name: string;
  refApplicantCount: number;
  active: boolean;
  settings: ExamSettingDto;
  counts: { questions: number; candidates: number };
}

export interface UpdateSettings {
  durationMinutes: number;
  windowStart: string | null;
  windowEnd: string | null;
  instructions: string;
  isOpen: boolean;
}

export const rolesKey = ['admin', 'roles'] as const;

export function useRoles() {
  return useQuery({ queryKey: rolesKey, queryFn: () => apiFetch<JobRole[]>('admin', '/roles') });
}

/** POST a new role (name required), or PATCH an existing one (any subset, e.g. just `active`). */
export type SaveRole =
  | { id?: undefined; name: string; refApplicantCount?: number }
  | { id: string; name?: string; refApplicantCount?: number; active?: boolean };

export function useSaveRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: SaveRole) =>
      id
        ? apiFetch<JobRole>('admin', `/roles/${id}`, { method: 'PATCH', json: body })
        : apiFetch<JobRole>('admin', '/roles', { method: 'POST', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rolesKey }),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateSettings & { id: string }) =>
      apiFetch<ExamSettingDto>('admin', `/roles/${id}/settings`, { method: 'PUT', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rolesKey }),
  });
}
