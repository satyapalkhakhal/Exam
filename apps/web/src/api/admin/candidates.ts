// src/api/admin/candidates.ts
// Why: candidate list/detail/edit/eligibility/exemption/reset and CSV/XLSX import (plan
// Task 9). DTO shapes beyond the plan's prose are assumed; see task-14-report.md.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { ImportPreview, ImportResult } from '@/lib/importState';
import type { Paged } from './users';
import type { CandidateExamStatsDto, CandidateMatchingIdsDto } from '@exam/shared';
import { candidateQuery, type CandidateFilters } from '@/lib/candidateQuery';

/** Exam progress only; shortlist / reject live in `result`. */
export const CANDIDATE_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number] | 'SHORTLISTED' | 'REJECTED';
export type CandidateResult = 'SHORTLISTED' | 'REJECTED';

export type { CandidateFilters, CandidateSort } from '@/lib/candidateQuery';

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
  result: CandidateResult | null;
  eligible: boolean;
  locationExempt: boolean;
  flagCount: number;
  createdAt: string;
}

/** A list row: the candidate plus their current attempt and other applications. */
export interface CandidateListItem extends CandidateRow {
  exam: CandidateExamStatsDto | null;
  otherApplications: { jobRoleName: string; status: CandidateStatus; result: CandidateResult | null }[];
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
  fromResult: CandidateResult | null;
  toResult: CandidateResult | null;
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
  /** The same person's applications under other job roles (docs/multi-exam.md). Optional until the API ships. */
  otherApplications?: { id: string; candidateCode: string; jobRole: { id: string; name: string }; status: string; result: CandidateResult | null }[];
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
  const q = candidateQuery(f, page, pageSize);
  return useQuery({
    queryKey: ['admin', 'candidates', 'list', q.toString()],
    queryFn: () => apiFetch<Paged<CandidateListItem>>('admin', `/candidates?${q.toString()}`),
    placeholderData: keepPreviousData,
  });
}

/** Every candidate matching the filters (for "select all matching"); the API refuses more than 1000. */
export function fetchMatchingCandidateIds(f: CandidateFilters): Promise<CandidateMatchingIdsDto> {
  return apiFetch<CandidateMatchingIdsDto>('admin', `/candidates/ids?${candidateQuery(f).toString()}`);
}

/** The full email and mobile of one candidate (the "Show" button). The API audits every call. */
export function useRevealContact(id: string) {
  return useMutation({
    mutationFn: () => apiFetch<{ email: string; mobile: string | null }>('admin', `/candidates/${id}/contact`),
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

/** One candidate added by hand: name, email and role are required, the rest optional. */
export interface CandidateCreate extends Omit<CandidateEdit, 'fullName' | 'email' | 'jobRoleId'> {
  fullName: string;
  email: string;
  jobRoleId: string;
}

export interface BulkJobRoleResult {
  updated: number;
  skipped: { candidateId: string; candidateCode: string | null; fullName: string | null; reason: 'STARTED' | 'SAME_ROLE' | 'SAME_PERSON_HAS_ROLE' | 'NOT_FOUND' }[];
}

/** Moves the given candidates to one job role; those who started (or already hold it) are skipped. */
export function useBulkJobRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { candidateIds: string[]; jobRoleId: string }) =>
      apiFetch<BulkJobRoleResult>('admin', '/candidates/bulk/job-role', { method: 'POST', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
}

export function useCreateCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CandidateCreate) => apiFetch<CandidateRow>('admin', '/candidates', { method: 'POST', json: body }),
    // Dashboard counts change too, so refresh everything under 'admin'.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
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

export function previewCandidateImport(
  file: File,
  jobRoleId: string,
  opts: { updateExisting?: boolean } = {},
): Promise<ImportPreview<Record<string, unknown>>> {
  const body = new FormData();
  body.append('file', file);
  body.append('jobRoleId', jobRoleId);
  if (opts.updateExisting) body.append('updateExisting', 'true');
  return apiFetch('admin', '/candidates/import/preview', { method: 'POST', body });
}

export function confirmCandidateImport(a: { previewId: string; force?: boolean }): Promise<ImportResult> {
  return apiFetch('admin', '/candidates/import/confirm', { method: 'POST', json: a.force ? a : { previewId: a.previewId } });
}
