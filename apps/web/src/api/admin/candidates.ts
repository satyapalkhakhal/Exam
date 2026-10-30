// src/api/admin/candidates.ts
// Why: candidate list/detail/edit/eligibility/exemption/reset and CSV/XLSX import (plan
// Task 9). DTO shapes beyond the plan's prose are assumed; see task-14-report.md.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { ImportPreview, ImportResult } from '@/lib/importState';
import type { Paged } from './users';

export const CANDIDATE_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'AUTO_SUBMITTED',
  'EVALUATED',
  'SHORTLISTED',
  'REJECTED',
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export type CandidateSort = 'fullName' | 'majorCpi' | 'xPercentage' | 'xiiPercentage' | 'createdAt';

export interface CandidateRow {
  id: string;
  candidateCode: string;
  fullName: string;
  email: string;
  mobile: string | null;
  rollNumber: string | null;
  xPercentage: number | null;
  xiiPercentage: number | null;
  majorCpi: number | null;
  discipline: string | null;
  programme: string | null;
  jobRoleId: string;
  jobRoleName: string;
  status: CandidateStatus;
  eligible: boolean;
  locationExempt: boolean;
  flagCount: number;
  createdAt: string;
}

export interface CandidateDetailProfile extends CandidateRow {
  extra: Record<string, unknown>;
}

export interface LoginLog {
  id: string;
  kind: 'LOGIN' | 'START' | string;
  createdAt: string;
  permission: 'GRANTED' | 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT' | string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  ip: string | null;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
}

export interface ActivityRow {
  id: string;
  type: string;
  createdAt: string;
  detail: unknown;
}

/** Review flags as built by the API's exam.getFlags (modules/exam/flagScore.ts). */
export interface IntegrityCounts {
  pasteAttempts: number;
  bulkInsert: number;
  tabHidden: number;
  blur: number;
  ipChanges: number;
}

export interface LocationFlagItem {
  code: string;
  [key: string]: unknown;
}

export interface CandidateFlags {
  integrity: IntegrityCounts;
  location: LocationFlagItem[];
}

export interface HistoryRow {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface CandidateDetailDto {
  candidate: CandidateDetailProfile;
  loginLogs: LoginLog[];
  attempt: { id: string; status: string; startedAt: string | null; submittedAt: string | null } | null;
  activity: Paged<ActivityRow>;
  flags: CandidateFlags | null;
  history: HistoryRow[];
}

export interface CandidateFilters {
  search: string;
  jobRoleId: string;
  status: string;
  flagged: '' | 'true' | 'false';
  sort: CandidateSort;
  dir: 'asc' | 'desc';
}

export interface CandidateEdit {
  fullName?: string;
  email?: string;
  mobile?: string | null;
  rollNumber?: string | null;
  xPercentage?: number | null;
  xiiPercentage?: number | null;
  majorCpi?: number | null;
  discipline?: string | null;
  programme?: string | null;
  jobRoleId?: string;
}

export const CANDIDATE_TEMPLATE_URL = '/api/admin/candidates/template.csv';

export function useCandidates(f: CandidateFilters, page: number, pageSize: number) {
  const q = new URLSearchParams({ sort: f.sort, dir: f.dir, page: String(page), pageSize: String(pageSize) });
  if (f.search) q.set('search', f.search);
  if (f.jobRoleId) q.set('jobRoleId', f.jobRoleId);
  if (f.status) q.set('status', f.status);
  if (f.flagged) q.set('flagged', f.flagged);
  return useQuery({
    queryKey: ['admin', 'candidates', 'list', q.toString()],
    queryFn: () => apiFetch<Paged<CandidateRow>>('admin', `/candidates?${q.toString()}`),
    placeholderData: keepPreviousData,
  });
}

export function useCandidate(id: string, activityPage: number) {
  return useQuery({
    queryKey: ['admin', 'candidates', 'detail', id, activityPage],
    queryFn: () => apiFetch<CandidateDetailDto>('admin', `/candidates/${id}?activityPage=${activityPage}`),
    placeholderData: keepPreviousData,
  });
}

function useCandidateMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'candidates'] }),
  });
}

export const useEditCandidate = (id: string) =>
  useCandidateMutation((body: CandidateEdit) => apiFetch('admin', `/candidates/${id}`, { method: 'PATCH', json: body }));

export const useSetEligibility = (id: string) =>
  useCandidateMutation((eligible: boolean) =>
    apiFetch('admin', `/candidates/${id}/eligibility`, { method: 'PATCH', json: { eligible } }),
  );

export const useSetLocationExempt = (id: string) =>
  useCandidateMutation((v: { exempt: boolean; reason: string }) =>
    apiFetch('admin', `/candidates/${id}/location-exempt`, { method: 'PATCH', json: v }),
  );

export const useResetAttempt = (id: string) =>
  useCandidateMutation((reason: string) =>
    apiFetch('admin', `/candidates/${id}/reset-attempt`, { method: 'POST', json: { reason } }),
  );

export function previewCandidateImport(file: File, jobRoleId: string): Promise<ImportPreview<Record<string, unknown>>> {
  const body = new FormData();
  body.append('file', file);
  body.append('jobRoleId', jobRoleId);
  return apiFetch('admin', '/candidates/import/preview', { method: 'POST', body });
}

export function confirmCandidateImport(a: { previewId: string; force?: boolean }): Promise<ImportResult> {
  return apiFetch('admin', '/candidates/import/confirm', { method: 'POST', json: a.force ? a : { previewId: a.previewId } });
}
