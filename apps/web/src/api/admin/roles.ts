// src/api/admin/roles.ts
// Why: job profiles (code: job roles) with their type and rounds (spec 2026-11-10).
// A Super Admin's list carries each round's drives; an Evaluator's never does.
// Round settings and drives are edited through ./drives.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobProfileType, JobRoleDto } from '@exam/shared';
import { apiFetch } from '@/lib/api';

export type JobRole = JobRoleDto;

export const rolesKey = ['admin', 'roles'] as const;

export function useRoles() {
  return useQuery({ queryKey: rolesKey, queryFn: () => apiFetch<JobRole[]>('admin', '/roles') });
}

/** POST a new job profile (name required, Round 1 is created with it), or PATCH an existing one. */
export type SaveRole =
  | { id?: undefined; name: string; type: JobProfileType; refApplicantCount?: number }
  | { id: string; name?: string; type?: JobProfileType; refApplicantCount?: number; active?: boolean };

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
